import dotenv from "dotenv";

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("GEMINI_API_KEY não configurada. Defina no .env e rode novamente.");
  process.exit(1);
}

const url = "https://generativelanguage.googleapis.com/v1beta/models";

const response = await fetch(url, {
  headers: {
    "x-goog-api-key": apiKey,
  },
});

if (!response.ok) {
  const text = await response.text().catch(() => "");
  console.error(`Falha ao listar modelos: ${response.status} ${response.statusText}`);
  if (text) console.error(text);
  process.exit(1);
}

const data = await response.json();
const models = Array.isArray(data?.models) ? data.models : [];

const supported = models
  .filter(
    (m) =>
      Array.isArray(m?.supportedGenerationMethods) &&
      m.supportedGenerationMethods.includes("generateContent")
  )
  .map((m) => ({
    name: m.name,
    baseModelId: m.baseModelId,
    displayName: m.displayName,
  }));

supported.sort((a, b) => String(a.name).localeCompare(String(b.name)));

console.log("Modelos com generateContent:");
for (const m of supported) {
  console.log(
    `- ${m.name}${m.baseModelId ? ` (baseModelId=${m.baseModelId})` : ""}${
      m.displayName ? ` (${m.displayName})` : ""
    }`
  );
}

console.log("\nSugestão:");
console.log(
  "- Pegue o sufixo depois de `models/` e use em GEMINI_MODEL. Ex: `models/gemini-2.0-flash` => GEMINI_MODEL=gemini-2.0-flash"
);

