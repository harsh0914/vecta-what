import { ItemProfile, Pairing, PairingRole } from '../types.js';

export interface EnrichmentItemInput {
  id: string;
  name: string;
  alternateName?: string;
  price?: number;
  categories?: string[];
  tags?: string[];
}

export interface EnrichmentRequest {
  merchantContext?: {
    name?: string;
    city?: string;
    state?: string;
  };
  menuOutline?: string[];
  items: EnrichmentItemInput[];
}

export interface EnrichmentItemOutput {
  item_id: string;
  profile: ItemProfile;
}

export interface EnrichmentResult {
  items: EnrichmentItemOutput[];
}

export interface PairingAnchorInput {
  id: string;
  name: string;
  categories: string[];
  tags: string[];
  price?: number;
  cuisine?: string;
  course?: string;
  spice_level?: number;
  description?: string;
}

export interface PairingRequest {
  menu: PairingAnchorInput[];
  anchors: PairingAnchorInput[];
}

export interface PairingPairOutput {
  item_id: string;
  role: PairingRole;
  reason: string;
}

export interface PairingAnchorOutput {
  anchor_id: string;
  pairs: PairingPairOutput[];
}

export interface PairingResult {
  anchors: PairingAnchorOutput[];
}

export interface AgentToolDeclaration {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, any>;
}

export interface AgentTurnRequest {
  systemInstruction?: string;
  messages: Array<{ role: 'user' | 'model' | 'tool'; content: string | any }>;
  tools?: AgentToolDeclaration[];
  executeTool?: (name: string, args: Record<string, any>) => Promise<any>;
  sessionId?: string;
}

export interface AgentTurnResult {
  reply: string;
  toolCallsMade?: Array<{ name: string; args: any; result: any }>;
  sessionId?: string;
}

export interface Llm {
  enrichItems(req: EnrichmentRequest): Promise<EnrichmentResult>;
  generatePairings(req: PairingRequest): Promise<PairingResult>;
  executeAgentTurn(req: AgentTurnRequest): Promise<AgentTurnResult>;
}
