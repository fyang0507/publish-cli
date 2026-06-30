import { GoogleGenAI, type ThinkingLevel } from "@google/genai";
import { env } from "./config.js";

/**
 * Thin Gemini client over @google/genai, mirroring outreach-cli's usage of the
 * same SDK (construct GoogleGenAI with { apiKey }, drive thinking via
 * thinkingConfig.thinkingLevel).
 *
 * Used for two jobs:
 *   - watch-loop triage: cheap model, minimal thinking budget (see triage()).
 *   - optional drafting/tailoring: caller passes a richer model id.
 */
export class GeminiClient {
  private ai: GoogleGenAI;

  constructor(apiKey: string = env.GOOGLE_GENERATIVE_AI_API_KEY) {
    if (!apiKey) {
      throw new Error(
        "GOOGLE_GENERATIVE_AI_API_KEY is not set — add it to .env (see .env.example).",
      );
    }
    this.ai = new GoogleGenAI({ apiKey });
  }

  /**
   * One-shot text generation.
   * @param thinkingLevel defaults to "minimal" to keep cost/latency low; pass a
   *   higher level for drafting where reasoning helps.
   */
  async generate(
    model: string,
    prompt: string,
    thinkingLevel: ThinkingLevel = "minimal" as ThinkingLevel,
  ): Promise<string> {
    const res = await this.ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        thinkingConfig: {
          thinkingLevel,
          includeThoughts: false,
        },
      },
    });
    return res.text ?? "";
  }

  /**
   * Triage helper for the watch loop: cheap model + low reasoning effort.
   * Returns the raw model text; the caller is responsible for parsing the
   * scored JSON it asked the model to produce in `prompt`.
   *
   * @param model cheap model id (e.g. gemini-3.5-flash / TRIAGE_MODEL).
   * @param thinkingLevel reasoning effort; defaults to "low" per Fred's spec
   *   (cheap but slightly better discrimination than "minimal").
   */
  async triage(
    model: string,
    prompt: string,
    thinkingLevel: ThinkingLevel = "low" as ThinkingLevel,
  ): Promise<string> {
    return this.generate(model, prompt, thinkingLevel);
  }
}
