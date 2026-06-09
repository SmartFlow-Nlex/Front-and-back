export async function getAuditLogData() {
  return {
    module: "audit-log",
    message: "audit-log API ready",
    updatedAt: new Date().toISOString(),
  };
}
