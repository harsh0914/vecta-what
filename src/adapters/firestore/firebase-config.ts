import fs from 'fs';
import path from 'path';

export interface FirebaseAppletConfig {
  projectId: string;
  firestoreDatabaseId: string;
  apiKey?: string;
  authDomain?: string;
  appId?: string;
  storageBucket?: string;
}

export function loadFirebaseConfig(configPath?: string): FirebaseAppletConfig | null {
  const filePath = configPath || path.resolve(process.cwd(), 'firebase-applet-config.json');
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(`Invalid JSON in ${filePath}: ${err.message}`);
  }

  if (!parsed.projectId || !parsed.firestoreDatabaseId) {
    throw new Error('firebase-applet-config.json missing required projectId or firestoreDatabaseId');
  }

  return {
    projectId: parsed.projectId,
    firestoreDatabaseId: parsed.firestoreDatabaseId,
    apiKey: parsed.apiKey,
    authDomain: parsed.authDomain,
    appId: parsed.appId,
    storageBucket: parsed.storageBucket,
  };
}
