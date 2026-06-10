export async function getAiSandboxData() {
  return {
    module: "ai-sandbox",
    message: "ai-sandbox API ready",
    updatedAt: new Date().toISOString(),
  };
}
