export async function getDashboardData() {
  return {
    module: "dashboard",
    message: "dashboard API ready",
    updatedAt: new Date().toISOString(),
  };
}
