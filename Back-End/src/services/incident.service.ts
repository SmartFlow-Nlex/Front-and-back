export async function getIncidentData() {
  return {
    module: "incident",
    message: "incident API ready",
    updatedAt: new Date().toISOString(),
  };
}
