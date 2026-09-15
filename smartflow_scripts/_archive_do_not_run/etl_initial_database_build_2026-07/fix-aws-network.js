throw new Error("ARCHIVED - do not run. First database build and ingestion (July 2026), before the medallion schema. Writes and truncates tables that have since been rebuilt. Kept only as a record; see smartflow_scripts/README.md.");
import { EC2Client, DescribeVpcsCommand, CreateInternetGatewayCommand, AttachInternetGatewayCommand, DescribeInternetGatewaysCommand, DescribeRouteTablesCommand, CreateRouteCommand, DescribeSecurityGroupsCommand, AuthorizeSecurityGroupIngressCommand } from "@aws-sdk/client-ec2";
import { RDSClient, DescribeDBInstancesCommand, ModifyDBInstanceCommand } from "@aws-sdk/client-rds";

const region = "ap-southeast-1";
  // AWS credentials REMOVED. They were live keys for the account that hosts the
  // RDS instance; rotate them in IAM if that has not been done.
const credentials = {
  accessKeyId: "REMOVED",
  secretAccessKey: "REMOVED"
};

const ec2 = new EC2Client({ region, credentials });
const rds = new RDSClient({ region, credentials });

async function fixNetwork() {
  console.log("🚀 Starting AWS Network Automation for smartflow...");

  // 1. Get RDS Instance Details
  const rdsInfo = await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: "smartflow" }));
  const db = rdsInfo.DBInstances[0];
  const vpcId = db.DBSubnetGroup.VpcId;
  const sgId = db.VpcSecurityGroups[0].VpcSecurityGroupId;
  console.log(`✅ Found RDS Database (VPC: ${vpcId}, SG: ${sgId})`);

  // 2. Check for Internet Gateway
  const igws = await ec2.send(new DescribeInternetGatewaysCommand({
    Filters: [{ Name: "attachment.vpc-id", Values: [vpcId] }]
  }));
  
  let igwId;
  if (igws.InternetGateways.length > 0) {
    igwId = igws.InternetGateways[0].InternetGatewayId;
    console.log(`✅ Found existing Internet Gateway: ${igwId}`);
  } else {
    console.log("⚠️ No Internet Gateway found. Creating one...");
    const newIgw = await ec2.send(new CreateInternetGatewayCommand({}));
    igwId = newIgw.InternetGateway.InternetGatewayId;
    await ec2.send(new AttachInternetGatewayCommand({ InternetGatewayId: igwId, VpcId: vpcId }));
    console.log(`✅ Created and attached Internet Gateway: ${igwId}`);
  }

  // 3. Fix Route Table
  const rts = await ec2.send(new DescribeRouteTablesCommand({
    Filters: [{ Name: "vpc-id", Values: [vpcId] }]
  }));
  
  for (const rt of rts.RouteTables) {
    const hasInternetRoute = rt.Routes.some(r => r.DestinationCidrBlock === "0.0.0.0/0");
    if (!hasInternetRoute) {
      console.log(`⚠️ Adding internet route to Route Table: ${rt.RouteTableId}`);
      try {
        await ec2.send(new CreateRouteCommand({
          RouteTableId: rt.RouteTableId,
          DestinationCidrBlock: "0.0.0.0/0",
          GatewayId: igwId
        }));
        console.log(`✅ Fixed Route Table ${rt.RouteTableId}`);
      } catch (err) {
        console.log(`   (Skipping main route table edit)`);
      }
    } else {
      console.log(`✅ Route Table ${rt.RouteTableId} already has internet access.`);
    }
  }

  // 4. Fix Security Group (Allow Port 5432)
  const sgs = await ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: [sgId] }));
  const sg = sgs.SecurityGroups[0];
  const hasDbRule = sg.IpPermissions.some(p => p.FromPort <= 5432 && p.ToPort >= 5432 && p.IpRanges.some(r => r.CidrIp === "0.0.0.0/0"));
  
  if (!hasDbRule) {
    console.log(`⚠️ Adding Port 5432 to Security Group: ${sgId}`);
    try {
      await ec2.send(new AuthorizeSecurityGroupIngressCommand({
        GroupId: sgId,
        IpPermissions: [{
          IpProtocol: "tcp",
          FromPort: 5432,
          ToPort: 5432,
          IpRanges: [{ CidrIp: "0.0.0.0/0" }]
        }]
      }));
      console.log(`✅ Security Group fixed.`);
    } catch (err) {
      if (err.name === 'InvalidPermission.Duplicate') {
         console.log(`✅ Security Group already has the rule.`);
      } else {
         console.error("❌ Failed to update SG:", err);
      }
    }
  } else {
    console.log(`✅ Security Group already allows Port 5432.`);
  }

  // 5. Make RDS Publicly Accessible
  if (!db.PubliclyAccessible) {
    console.log("⚠️ Changing RDS instance to Publicly Accessible...");
    await rds.send(new ModifyDBInstanceCommand({
      DBInstanceIdentifier: "smartflow",
      PubliclyAccessible: true,
      ApplyImmediately: true
    }));
    console.log(`✅ RDS is now updating to Publicly Accessible! (This will take a few minutes in AWS)`);
  } else {
    console.log(`✅ RDS is already Publicly Accessible.`);
  }

  console.log("\n🎉 Network Fix Complete! Waiting 30 seconds for AWS to propagate changes before running migration...");
}

fixNetwork().catch(console.error);
