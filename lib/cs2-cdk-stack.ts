import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as r53 from 'aws-cdk-lib/aws-route53';
import * as r53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export class Cs2CdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'VPC', {
      ipAddresses: cdk.aws_ec2.IpAddresses.cidr(
        ec2.Vpc.DEFAULT_CIDR_RANGE
      ),
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'SubnetGroup',
          subnetType: cdk.aws_ec2.SubnetType.PUBLIC,
        },
      ],
    });

    const cluster = new ecs.Cluster(this, 'Cluster', { vpc });
    cluster.addCapacity('DefaultCapacity', {
      instanceType: new ec2.InstanceType("t3.large"),
      desiredCapacity: 1,
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: autoscaling.BlockDeviceVolume.ebs(60)
      }]
    });

    const taskDef = new ecs.TaskDefinition(this, 'TaskDef', {
      compatibility: ecs.Compatibility.EC2,
      networkMode: ecs.NetworkMode.HOST,
    });

    const secretEnvVariables = new secretsmanager.Secret(this, 'SecretEnvVariables')

    taskDef.addContainer('DefaultContainer', {
      image: ecs.ContainerImage.fromRegistry("joedwards32/cs2"),
      memoryLimitMiB: 4096,
      portMappings: [{
        containerPort: 27015,
        hostPort: 27015,
        protocol: ecs.Protocol.UDP,
      },
      {
        containerPort: 27016,
        hostPort: 27016,
        protocol: ecs.Protocol.TCP
      }],
      environment: {
        CS2_SERVERNAME: "Private Server",
        CS2_STARTMAP: "de_dust2",
        CS2_MAPGROUP:"mg_dust",
        CS2_GAMEALIAS:"deathmatch",
        CS2_BOT_QUOTA:"0",
        CS2_RCON_PORT:"27016",
      },
      secrets: {
        STEAMUSER: ecs.Secret.fromSecretsManager(secretEnvVariables, 'STEAMUSER'),
        STEAMPASS: ecs.Secret.fromSecretsManager(secretEnvVariables, 'STEAMPASS'),
        CS2_PW: ecs.Secret.fromSecretsManager(secretEnvVariables, 'CS2_PW'),
        CS2_RCONPW: ecs.Secret.fromSecretsManager(secretEnvVariables, 'CS2_RCONPW'),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'CS2CDKLogStream'
      }),
    });

    taskDef.addContainer('HealthCheckContainer', {
      image: ecs.ContainerImage.fromRegistry("busybox:latest"),
      memoryLimitMiB: 256,
      essential: true,
      portMappings: [{
        containerPort: 8080,
        hostPort: 8080,
        protocol: ecs.Protocol.TCP
      }],
      entryPoint: ["sh", "-c"],
      command: [
        "echo 'starting healthcheck container' && while true; do { echo -e 'HTTP/1.1 200 OK\r\n'; echo 'ok'; } | nc -l -p 8080; done"
      ],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'CS2CDKHealthcheckLogStream'
      }),
    })

    const ecsService = new ecs.Ec2Service(this, 'Service', {
      cluster: cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
    });

    ecsService.connections.allowFromAnyIpv4(ec2.Port.udp(27015))
    ecsService.connections.allowFromAnyIpv4(ec2.Port.tcp(27016))
    ecsService.connections.allowFromAnyIpv4(ec2.Port.tcp(8080))

    const lbTarget = ecsService.loadBalancerTarget({
      containerName: 'DefaultContainer',
      containerPort: 27015,
      protocol: ecs.Protocol.UDP
    })
    const lbRCONTarget = ecsService.loadBalancerTarget({
      containerName: 'DefaultContainer',
      containerPort: 27016,
      protocol: ecs.Protocol.TCP
    })
    ecsService.registerLoadBalancerTargets()

    const loadBalancer = new elbv2.NetworkLoadBalancer(this, 'LoadBalancer', {
      vpc: vpc,
      crossZoneEnabled: false,
      internetFacing: true,
    })

    const listener = loadBalancer.addListener('LBListener', {
      port: 27015,
      protocol: elbv2.Protocol.UDP,
    })

    const rconListener = loadBalancer.addListener('LBRCONListener', {
      port: 27016,
      protocol: elbv2.Protocol.TCP,
    })

    listener.addTargets('LBTargets', {
      port: 27015,
      protocol: elbv2.Protocol.UDP,
      targets: [lbTarget],
      healthCheck: {
        protocol: elbv2.Protocol.HTTP,
        port: '8080'
      }
    })

    rconListener.addTargets('LBRCONTargets', {
      port: 27016,
      protocol: elbv2.Protocol.TCP,
      targets: [lbRCONTarget],
      healthCheck: {
        protocol: elbv2.Protocol.HTTP,
        port: '8080'
      }
    })

    const hostedZone = r53.HostedZone.fromLookup(this, 'HostedZone', {
      domainName: "cs2.corrosivekid.com",
    });

    const dnsRecord = new r53.ARecord(this, 'DnsRecord', {
      target: r53.RecordTarget.fromAlias(new r53Targets.LoadBalancerTarget(loadBalancer)),
      zone: hostedZone,
    })
  }
}
