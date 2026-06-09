export async function getMapComparisonData() {
  return {
    module: "map-comparison",
    message: "map-comparison API ready",
    updatedAt: new Date().toISOString(),
  };
}
