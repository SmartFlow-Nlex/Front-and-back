export async function getDataManagementData() {
  return {
    module: "data-management",
    message: "data-management API ready",
    updatedAt: new Date().toISOString(),
  };
}
