export async function getTrafficData() {
  return {
    module: "traffic",
    message: "traffic API ready",
    updatedAt: new Date().toISOString(),
  };
}
