import fs from "fs";
import path from "path";
import os from "os";

export interface AgentDefinition {
  id: string;
  name: string;
  role: string;
  description: string;
  systemPrompt: string;
  modelId: string;
  temperature: number;
  maxTokens: number;
  category: "Engineering" | "B2B Business" | "Creative" | "Auditing";
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_AGENTS: AgentDefinition[] = [
  {
    id: "agent-example-rfq",
    name: "Example Studio RFQ & Invoicing Agent",
    role: "Indian B2B Lead Estimator",
    description: "Calculates SAC 9989 18% GST (Haryana CGST/SGST vs IGST), paper GSM weights, offset vs digital pricing, and generates structured quotes.",
    systemPrompt: "You are the B2B estimator for Example Studio. Check the applicable tax rules and calculate invoice figures from supplied evidence; do not invent prices or customer facts.",
    modelId: "gemini-2.0-flash",
    temperature: 0.2,
    maxTokens: 4096,
    category: "B2B Business",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    id: "agent-code-architect",
    name: "Live Canvas Frontend Architect",
    role: "Principal TypeScript & React Specialist",
    description: "Builds production-ready React components, Tailwind styling, and dark-mode workstation interfaces matching Linear and Raycast.",
    systemPrompt: "You are a Principal Design Systems Architect and Lead Frontend Engineer specializing in Next.js, Tailwind CSS, Framer Motion, and luxury dark-mode design systems.",
    modelId: "claude-3-7-sonnet",
    temperature: 0.4,
    maxTokens: 8192,
    category: "Engineering",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    id: "agent-security-auditor",
    name: "Metal GPU Security Auditor",
    role: "Air-Gapped Cryptographic Auditor",
    description: "Audits codebase architectures, verifies loopback socket ownership, AES-256 encryption at rest, and zero-leak guarantees.",
    systemPrompt: "You are a Lead Cryptographic and Systems Security Auditor. Verify air-gapped guarantees, loopback socket bindings, and process memory hygiene.",
    modelId: "qwen3-8b-q4-k-m",
    temperature: 0.1,
    maxTokens: 4096,
    category: "Auditing",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
];

export class AgentEngine {
  private static getStorageDir(): string {
    const dir = path.join(os.homedir(), ".cadrane", "agents");
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  public static async listAgents(): Promise<AgentDefinition[]> {
    const dir = this.getStorageDir();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    if (files.length === 0) {
      // Seed default agents
      for (const agent of DEFAULT_AGENTS) {
        fs.writeFileSync(path.join(dir, `${agent.id}.json`), JSON.stringify(agent, null, 2));
      }
      return DEFAULT_AGENTS;
    }

    const agents: AgentDefinition[] = [];
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, f), "utf-8");
        agents.push(JSON.parse(raw));
      } catch {
        // ignore malformed
      }
    }
    return agents;
  }

  public static async saveAgent(agent: AgentDefinition): Promise<void> {
    const dir = this.getStorageDir();
    fs.writeFileSync(path.join(dir, `${agent.id}.json`), JSON.stringify(agent, null, 2));
  }

  public static async deleteAgent(id: string): Promise<void> {
    const dir = this.getStorageDir();
    const filePath = path.join(dir, `${id}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}
