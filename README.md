# cs2-cdk

An [AWS CDK](https://aws.amazon.com/cdk/) (TypeScript) app that deploys a dedicated **Counter-Strike 2** server on AWS, using the [`joedwards32/cs2`](https://hub.docker.com/r/joedwards32/cs2) Docker image on ECS.

## Architecture

The stack (`lib/cs2-cdk-stack.ts`) creates:

- **VPC** with public subnets only and no NAT gateways, to keep costs down.
- **ECS cluster** backed by an Auto Scaling group with one `t3.small` EC2 instance.
- **Task definition** in `host` network mode with two containers:
  - `DefaultContainer`: the CS2 server (game on UDP `27015`, RCON on TCP `27016`).
  - `HealthCheckContainer`: a small busybox HTTP responder on TCP `8080` that the load balancer health checks use, since UDP targets can't be health-checked directly.
- **Persistent EBS volume** (50 GB `gp2`) mounted at `/home/steam/cs2-dedicated/` through the [REX-Ray EBS](https://github.com/rexray/rexray) Docker volume plugin. The game files survive task restarts and don't need to be downloaded again each time. The plugin uses the `umsp/rexray-ebs:nvme-fix` build so it works with NVMe devices on T3 instances.
- **Secrets Manager secret** (`CS2CDKSecretEnvVariables`) for the Steam credentials and server passwords.
- **Network Load Balancer** with listeners on UDP `27015` and TCP `27016`.
- **Route 53 alias record** pointing the `cs2.corrosivekid.com` hosted zone at the load balancer.
- **CloudWatch Logs** for both containers.

## Prerequisites

- Node.js and Yarn (the versions are pinned in `.tool-versions` for [asdf](https://asdf-vm.com/) users)
- AWS credentials configured for the target account and region
- An existing Route 53 hosted zone for `cs2.corrosivekid.com`. To use a different domain, change `domainName` in `lib/cs2-cdk-stack.ts`.
- The target account/region bootstrapped for CDK:

  ```sh
  npx cdk bootstrap
  ```

## Deploying

```sh
yarn install
npx cdk deploy
```

The stack picks up its account and region from `CDK_DEFAULT_ACCOUNT` and `CDK_DEFAULT_REGION`, which the CDK CLI sets from your current AWS profile.

### Set the secrets

The deploy creates the `CS2CDKSecretEnvVariables` secret with a placeholder value. The server task can't start until you replace that value with a JSON object containing these keys:

| Key          | Description                                  |
| ------------ | -------------------------------------------- |
| `STEAMUSER`  | Steam account username used to download CS2  |
| `STEAMPASS`  | Steam account password                       |
| `CS2_PW`     | Password players need to join the server     |
| `CS2_RCONPW` | RCON password                                |

For example:

```sh
aws secretsmanager put-secret-value \
  --secret-id <secret-arn-or-name> \
  --secret-string '{"STEAMUSER":"...","STEAMPASS":"...","CS2_PW":"...","CS2_RCONPW":"..."}'
```

Once the value is set, ECS will retry the task. The first start takes a while because the game files (roughly 30+ GB) download onto the EBS volume.

## Connecting

In the CS2 console:

```
connect cs2.corrosivekid.com:27015; password <CS2_PW>
```

## Configuration

Non-secret server settings are passed to the container as environment variables in `lib/cs2-cdk-stack.ts`:

| Variable          | Default          |
| ----------------- | ---------------- |
| `CS2_SERVERNAME`  | `Private Server` |
| `CS2_STARTMAP`    | `de_dust2`       |
| `CS2_MAPGROUP`    | `mg_dust`        |
| `CS2_GAMEALIAS`   | `deathmatch`     |
| `CS2_BOT_QUOTA`   | `0`              |
| `CS2_RCON_PORT`   | `27016`          |

See the [`joedwards32/cs2` documentation](https://github.com/joedwards32/CS2) for the full list of supported variables. After editing, run `npx cdk deploy` again.

## Useful commands

- `yarn build`: compile TypeScript to JavaScript
- `yarn watch`: watch for changes and compile
- `yarn test`: run the Jest unit tests
- `npx cdk synth`: print the synthesized CloudFormation template
- `npx cdk diff`: compare the deployed stack with the current code
- `npx cdk deploy`: deploy the stack
- `npx cdk destroy`: tear the stack down

## Cost and cleanup

The main running costs are the EC2 instance, the Network Load Balancer and the EBS volume. To stop paying for compute while the server isn't in use, set the service's desired count and the Auto Scaling group's capacity to `0`. To remove everything, run `npx cdk destroy`.

The EBS volume is created by the REX-Ray plugin rather than by CloudFormation, so `cdk destroy` does **not** delete it. Delete it yourself in the EC2 console if you no longer need the game files.
