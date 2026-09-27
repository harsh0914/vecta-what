import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';

let cachedClient: GoogleGenAI | null = null;
let loggedTextModel = false;
let loggedEmbedModel = false;

export function getProjectId(): string {
  if (process.env.GOOGLE_CLOUD_PROJECT) {
    return process.env.GOOGLE_CLOUD_PROJECT;
  }
  if (process.env.GCP_PROJECT) {
    return process.env.GCP_PROJECT;
  }
  try {
    const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (parsed.projectId) return parsed.projectId;
    }
  } catch (err) {
    console.warn('[gemini-client] Could not read firebase-applet-config.json:', err);
  }
  return 'gen-lang-client-0984511774';
}

export function getVertexGenAIClient(): GoogleGenAI {
  if (cachedClient) return cachedClient;

  const project = getProjectId();
  const location = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';

  cachedClient = new GoogleGenAI({
    vertexai: true,
    project,
    location,
  });

  return cachedClient;
}

export function getTextModelName(requested = 'gemini-2.5-flash'): string {
  const model = requested || 'gemini-2.5-flash';
  if (!loggedTextModel) {
    console.log(`[gemini-client] Using Vertex AI text model: ${model}`);
    loggedTextModel = true;
  }
  return model;
}

export function getEmbeddingModelName(requested = 'gemini-embedding-001'): string {
  const model = requested || 'gemini-embedding-001';
  if (!loggedEmbedModel) {
    console.log(`[gemini-client] Using Vertex AI embedding model: ${model} (768d)`);
    loggedEmbedModel = true;
  }
  return model;
}
