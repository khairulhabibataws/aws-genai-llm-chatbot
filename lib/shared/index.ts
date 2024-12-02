import * as cdk from "aws-cdk-lib";
import * as kms from "aws-cdk-lib/aws-kms";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as logs from "aws-cdk-lib/aws-logs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";
import * as path from "path";
import { Layer } from "../layer";
import { SystemConfig, SupportedBedrockRegion } from "./types";
import { SharedAssetBundler } from "./shared-asset-bundler";
import { NagSuppressions } from "cdk-nag";

const pythonRuntime = lambda.Runtime.PYTHON_3_11;
const lambdaArchitecture = lambda.Architecture.X86_64;
process.env.DOCKER_DEFAULT_PLATFORM = lambdaArchitecture.dockerPlatform;

export interface SharedProps {
  readonly config: SystemConfig;
}

export class Shared extends Construct {
  readonly vpc: ec2.Vpc;
  readonly kmsKey: kms.Key;
  readonly kmsKeyAlias: string;
  readonly queueKmsKey: kms.Key;
  readonly queueKmsKeyAlias: string;
  readonly defaultEnvironmentVariables: Record<string, string>;
  readonly configParameter: ssm.StringParameter;
  readonly pythonRuntime: lambda.Runtime = pythonRuntime;
  readonly lambdaArchitecture: lambda.Architecture = lambdaArchitecture;
  readonly xOriginVerifySecret: secretsmanager.Secret;
  readonly apiKeysSecret: secretsmanager.Secret;
  readonly commonLayer: lambda.ILayerVersion;
  readonly powerToolsLayer: lambda.ILayerVersion;
  readonly sharedCode: SharedAssetBundler;
  readonly s3vpcEndpoint: ec2.InterfaceVpcEndpoint;
  readonly modelConfigTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: SharedProps) {
    super(scope, id);

    this.kmsKeyAlias = props.config.prefix + "genaichatbot-shared-key";
    this.queueKmsKeyAlias =
      props.config.prefix + "genaichatbot-queue-shared-key";
    const powerToolsLayerVersion = "1";

    this.defaultEnvironmentVariables = {
      POWERTOOLS_DEV: "false",
      LOG_LEVEL: "INFO",
      // Event might contain end user information and should not be logged by default
      POWERTOOLS_LOGGER_LOG_EVENT: "false",
      POWERTOOLS_SERVICE_NAME: "chatbot",
      AWS_XRAY_SDK_ENABLED: props.config.advancedMonitoring ? "true" : "false",
      POWERTOOLS_TRACE_DISABLED: props.config.advancedMonitoring
        ? "false"
        : "true",
    };

    if (props.config.createCMKs) {
      this.kmsKey = new kms.Key(this, "KMSKey", {
        enableKeyRotation: true,
        // The key is not a data store but is needed to read the retained tables for example
        removalPolicy:
          props.config.retainOnDelete === true
            ? cdk.RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE
            : cdk.RemovalPolicy.DESTROY,
        alias: this.kmsKeyAlias,
      });

      // Revisit once the following is merged (Causing circular dependency without a second key)
      // https://github.com/aws/aws-cdk/pull/31155
      // Using the same queue for an SQS and event is causing issues.
      this.queueKmsKey = new kms.Key(this, "QueueKMSKey", {
        enableKeyRotation: true,
        // The key is only used for temporary stores (SQS)
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        alias: this.queueKmsKeyAlias,
      });
    }

    let vpc: ec2.Vpc;
    if (!props.config.vpc?.vpcId) {
      vpc = new ec2.Vpc(this, "VPC", {
        natGateways: 1,
        restrictDefaultSecurityGroup: false,
        subnetConfiguration: [
          {
            name: "public",
            subnetType: ec2.SubnetType.PUBLIC,
          },
          {
            name: "private",
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          },
          {
            name: "isolated",
            subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          },
        ],
      });
      const logGroup = new logs.LogGroup(this, "FLowLogsLogGroup", {
        removalPolicy:
          props.config.retainOnDelete === true
            ? cdk.RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE
            : cdk.RemovalPolicy.DESTROY,
        retention: props.config.logRetention,
      });
      new ec2.FlowLog(this, "FlowLog", {
        resourceType: ec2.FlowLogResourceType.fromVpc(vpc),
        destination: ec2.FlowLogDestination.toCloudWatchLogs(logGroup),
      });
    } else {
      vpc = ec2.Vpc.fromLookup(this, "VPC", {
        vpcId: props.config.vpc.vpcId,
      }) as ec2.Vpc;
    }

    if (
      typeof props.config.vpc?.createVpcEndpoints === "undefined" ||
      props.config.vpc?.createVpcEndpoints === true
    ) {
      // Create a VPC endpoint for S3.
      const s3GatewayEndpoint = vpc.addGatewayEndpoint("S3GatewayEndpoint", {
        service: ec2.GatewayVpcEndpointAwsService.S3,
      });

      const s3vpcEndpoint = vpc.addInterfaceEndpoint("S3InterfaceEndpoint", {
        service: ec2.InterfaceVpcEndpointAwsService.S3,
        privateDnsEnabled: true,
        open: true,
      });

      this.s3vpcEndpoint = s3vpcEndpoint;

      s3vpcEndpoint.node.addDependency(s3GatewayEndpoint);

      // Create a VPC endpoint for DynamoDB.
      vpc.addGatewayEndpoint("DynamoDBEndpoint", {
        service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
      });

      // Create DynamoDB table for model configurations
      this.modelConfigTable = new dynamodb.Table(this, "ModelConfigTable", {
        tableName: "model-config",
        partitionKey: { name: "model_id", type: dynamodb.AttributeType.STRING },
        removalPolicy: props.config.retainOnDelete === true
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
        encryption: props.config.createCMKs
          ? dynamodb.TableEncryption.CUSTOMER_MANAGED
          : dynamodb.TableEncryption.AWS_MANAGED,
        encryptionKey: props.config.createCMKs ? this.kmsKey : undefined,
      });

      // Grant permissions to the Lambda function
      this.modelConfigTable.grantReadData(new iam.ServicePrincipal("lambda.amazonaws.com"));

      // Load initial model config data
      new cdk.aws_dynamodb.CfnGlobalTable(this, 'ModelConfigData', {
        tableName: this.modelConfigTable.tableName,
        replicas: [{
          region: cdk.Stack.of(this).region,
        }],
        attributeDefinitions: [{
          attributeName: 'model_id',
          attributeType: 'S'
        }],
        keySchema: [{
          attributeName: 'model_id',
          keyType: 'HASH'
        }],
        streamSpecification: {
          streamViewType: 'NEW_AND_OLD_IMAGES'
        },
        ttl: {
          attributeName: 'ttl',
          enabled: false
        }
      }).addDependsOn(this.modelConfigTable.node.defaultChild as cdk.CfnResource);

      // Add initial items to the table
      new cdk.CustomResource(this, 'LoadModelConfigData', {
        serviceToken: new cdk.custom_resources.Provider(this, 'ModelConfigDataProvider', {
          onEventHandler: new lambda.Function(this, 'ModelConfigDataLoader', {
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: 'index.handler',
            code: lambda.Code.fromInline(`
              const AWS = require('aws-sdk');
              const fs = require('fs');
              const dynamoDB = new AWS.DynamoDB();
              exports.handler = async (event) => {
                if (event.RequestType === 'Create' || event.RequestType === 'Update') {
                  const items = require('./model-config-data.json');
                  await dynamoDB.putItem({
                    TableName: '${this.modelConfigTable.tableName}',
                    Item: items
                  }).promise();
                }
                return { PhysicalResourceId: Date.now().toString() };
              };
            `),
            timeout: cdk.Duration.minutes(5)
          }),
        }),
        properties: {
          Version: Date.now().toString() // Force update on each deployment
        }
      });

      // Create VPC Endpoint for Secrets Manager
      vpc.addInterfaceEndpoint("SecretsManagerEndpoint", {
        service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
        open: true,
      });

      // Create VPC Endpoint for SageMaker Runtime
      vpc.addInterfaceEndpoint("SageMakerRuntimeEndpoint", {
        service: ec2.InterfaceVpcEndpointAwsService.SAGEMAKER_RUNTIME,
        open: true,
      });

      if (props.config.privateWebsite) {
        // Create VPC Endpoint for AppSync
        vpc.addInterfaceEndpoint("AppSyncEndpoint", {
          service: ec2.InterfaceVpcEndpointAwsService.APP_SYNC,
        });

        // Create VPC Endpoint for Lambda
        vpc.addInterfaceEndpoint("LambdaEndpoint", {
          service: ec2.InterfaceVpcEndpointAwsService.LAMBDA,
        });

        // Create VPC Endpoint for SNS
        vpc.addInterfaceEndpoint("SNSEndpoint", {
          service: ec2.InterfaceVpcEndpointAwsService.SNS,
        });

        // Create VPC Endpoint for Step Functions
        vpc.addInterfaceEndpoint("StepFunctionsEndpoint", {
          service: ec2.InterfaceVpcEndpointAwsService.STEP_FUNCTIONS,
        });

        // Create VPC Endpoint for SSM
        vpc.addInterfaceEndpoint("SSMEndpoint", {
          service: ec2.InterfaceVpcEndpointAwsService.SSM,
        });

        // Create VPC Endpoint for KMS
        vpc.addInterfaceEndpoint("KMSEndpoint", {
          service: ec2.InterfaceVpcEndpointAwsService.KMS,
        });

        // Create VPC Endpoint for Bedrock
        if (props.config.bedrock?.enabled) {
          const bedrockRegion =
            props.config.bedrock?.region || cdk.Stack.of(this).region;
          if (
            Object.values(SupportedBedrockRegion).some(
              (val) => val === bedrockRegion
            )
          ) {
            if (bedrockRegion === cdk.Stack.of(this).region) {
              vpc.addInterfaceEndpoint("BedrockEndpoint", {
                service: ec2.InterfaceVpcEndpointAwsService.BEDROCK,
              });
              vpc.addInterfaceEndpoint("BedrockRuntimeEndpoint", {
                service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
              });
            } else {
              const bedrockVpc = new ec2.Vpc(this, "BedrockVPC", {
                natGateways: 0,
                restrictDefaultSecurityGroup: false,
                subnetConfiguration: [
                  {
                    name: "isolated",
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                  },
                ],
              });
              const vpcPeering = new ec2.CfnVPCPeeringConnection(
                this,
                "BrVPCPeering",
                {
                  vpcId: vpc.vpcId,
                  peerVpcId: bedrockVpc.vpcId,
                }
              );
              vpc.privateSubnets.forEach(
                ({ routeTable: { routeTableId } }, index) => {
                  new ec2.CfnRoute(
                    this,
                    "RouteFromPvtSubnetOfVpcToBrVpc" + index,
                    {
                      destinationCidrBlock: bedrockVpc.vpcCidrBlock,
                      routeTableId: routeTableId,
                      vpcPeeringConnectionId: vpcPeering.ref,
                    }
                  );
                }
              );
              bedrockVpc.isolatedSubnets.forEach(
                ({ routeTable: { routeTableId } }, index) => {
                  new ec2.CfnRoute(
                    this,
                    "RouteFromIsoSubnetOfBrVpcToVpc" + index,
                    {
                      destinationCidrBlock: vpc.vpcCidrBlock,
                      routeTableId: routeTableId,
                      vpcPeeringConnectionId: vpcPeering.ref,
                    }
                  );
                }
              );
              bedrockVpc.addInterfaceEndpoint("BedrockEndpoint", {
                service: ec2.InterfaceVpcEndpointAwsService.BEDROCK,
              });
              bedrockVpc.addInterfaceEndpoint("BedrockRuntimeEndpoint", {
                service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
              });
            }
          }
        }

        // Create VPC Endpoint for Kendra
        if (props.config.rag.engines.kendra.enabled) {
          vpc.addInterfaceEndpoint("KendraEndpoint", {
            service: ec2.InterfaceVpcEndpointAwsService.KENDRA,
          });
        }

        // Create VPC Endpoint for RDS/Aurora
        if (props.config.rag.engines.aurora.enabled) {
          vpc.addInterfaceEndpoint("RDSEndpoint", {
            service: ec2.InterfaceVpcEndpointAwsService.RDS,
          });

          // Create VPC Endpoint for RDS Data
          vpc.addInterfaceEndpoint("RDSDataEndpoint", {
            service: ec2.InterfaceVpcEndpointAwsService.RDS_DATA,
          });
        }

        // Create VPC Endpoints needed for Aurora & Opensearch Indexing
        if (
          props.config.rag.engines.aurora.enabled ||
          props.config.rag.engines.opensearch.enabled
        ) {
          // Create VPC Endpoint for ECS
          vpc.addInterfaceEndpoint("ECSEndpoint", {
            service: ec2.InterfaceVpcEndpointAwsService.ECS,
          });

          // Create VPC Endpoint for Batch
          vpc.addInterfaceEndpoint("BatchEndpoint", {
            service: ec2.InterfaceVpcEndpointAwsService.BATCH,
          });

          // Create VPC Endpoint for EC2
          vpc.addInterfaceEndpoint("EC2Endpoint", {
            service: ec2.InterfaceVpcEndpointAwsService.EC2,
          });
        }
      }
    }

    const configParameter = new ssm.StringParameter(this, "Config", {
      stringValue: JSON.stringify(props.config),
    });

    const powerToolsArn =
      lambdaArchitecture === lambda.Architecture.X86_64
        ? `arn:${cdk.Aws.PARTITION}:lambda:${cdk.Aws.REGION}:017000801446:layer:AWSLambdaPowertoolsPythonV3-python311-x86:${powerToolsLayerVersion}`
        : `arn:${cdk.Aws.PARTITION}:lambda:${cdk.Aws.REGION}:017000801446:layer:AWSLambdaPowertoolsPythonV3-python311-arm64:${powerToolsLayerVersion}`;

    const powerToolsLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      "PowertoolsLayer",
      powerToolsArn
    );

    const commonLayer = new Layer(this, "CommonLayer", {
      runtime: pythonRuntime,
      architecture: lambdaArchitecture,
      path: path.join(__dirname, "./layers/common"),
    });

    this.sharedCode = new SharedAssetBundler(this, "genai-core", [
      path.join(__dirname, "layers", "python-sdk", "python", "genai_core"),
      path.join(__dirname, "layers", "python-sdk", "python", "genai_config"),
    ]);

    const xOriginVerifySecret = new secretsmanager.Secret(
      this,
      "X-Origin-Verify-Secret",
      {
        encryptionKey: this.kmsKey,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        generateSecretString: {
          excludePunctuation: true,
          generateStringKey: "headerValue",
          secretStringTemplate: "{}",
        },
      }
    );

    const apiKeysSecret = new secretsmanager.Secret(this, "ApiKeysSecret", {
      encryptionKey: this.kmsKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      secretObjectValue: {},
    });

    this.vpc = vpc;
    this.configParameter = configParameter;
    this.xOriginVerifySecret = xOriginVerifySecret;
    this.apiKeysSecret = apiKeysSecret;
    this.powerToolsLayer = powerToolsLayer;
    this.commonLayer = commonLayer.layer;

    new cdk.CfnOutput(this, "ApiKeysSecretName", {
      value: apiKeysSecret.secretName,
    });

    /**
     * CDK NAG suppression
     */
    NagSuppressions.addResourceSuppressions(xOriginVerifySecret, [
      { id: "AwsSolutions-SMG4", reason: "Secret is generated by CDK." },
    ]);
    NagSuppressions.addResourceSuppressions(apiKeysSecret, [
      { id: "AwsSolutions-SMG4", reason: "Secret value is blank." },
    ]);
  }
}
