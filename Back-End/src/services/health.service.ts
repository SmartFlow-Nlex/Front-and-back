export async function getHealth() {
  return {
    status: "ok",
    timestamp: new Date().toISOString(),
  };
}
