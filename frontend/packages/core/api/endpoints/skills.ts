import type {
  CreateSkillRequest,
  SetAgentSkillsRequest,
  Skill,
  SkillSummary,
  UpdateSkillRequest,
} from "../../types";
import type { HttpClient } from "../http";
import { parseStrictResponse } from "../schema";
import { SkillSchema } from "../schemas/skills";

export class SkillsEndpoints {
  constructor(readonly http: HttpClient) {}

  // Skills
  async listSkills(): Promise<SkillSummary[]> {
    return this.http.fetch("/api/skills");
  }

  async getSkill(id: string): Promise<Skill> {
    const raw = await this.http.fetch<unknown>(`/api/skills/${id}`);
    return parseStrictResponse(raw, SkillSchema, { endpoint: "GET /api/skills/:id" });
  }

  async createSkill(data: CreateSkillRequest): Promise<Skill> {
    const raw = await this.http.fetch<unknown>("/api/skills", {
      method: "POST",
      body: JSON.stringify(data),
    });
    return parseStrictResponse(raw, SkillSchema, { endpoint: "POST /api/skills" });
  }

  async updateSkill(id: string, data: UpdateSkillRequest): Promise<Skill> {
    const raw = await this.http.fetch<unknown>(`/api/skills/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
    return parseStrictResponse(raw, SkillSchema, { endpoint: "PUT /api/skills/:id" });
  }

  async deleteSkill(id: string): Promise<void> {
    await this.http.fetch(`/api/skills/${id}`, { method: "DELETE" });
  }

  async importSkill(data: { url: string }): Promise<Skill> {
    const raw = await this.http.fetch<unknown>("/api/skills/import", {
      method: "POST",
      body: JSON.stringify(data),
    });
    return parseStrictResponse(raw, SkillSchema, { endpoint: "POST /api/skills/import" });
  }

  async listAgentSkills(agentId: string): Promise<SkillSummary[]> {
    return this.http.fetch(`/api/agents/${agentId}/skills`);
  }

  async setAgentSkills(agentId: string, data: SetAgentSkillsRequest): Promise<void> {
    await this.http.fetch(`/api/agents/${agentId}/skills`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }
}
