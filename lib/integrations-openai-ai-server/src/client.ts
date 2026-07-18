import OpenAI from "openai";

function createClient(): OpenAI {
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (!baseURL || !apiKey) {
    throw new Error(
      "AI features require AI_INTEGRATIONS_OPENAI_BASE_URL and AI_INTEGRATIONS_OPENAI_API_KEY. " +
      "Add these to your .env file to enable AI-powered search and organisation.",
    );
  }
  return new OpenAI({ apiKey, baseURL });
}

let _client: OpenAI | undefined;

export const openai = new Proxy({} as OpenAI, {
  get(_target, prop) {
    if (!_client) _client = createClient();
    return (_client as any)[prop];
  },
});
