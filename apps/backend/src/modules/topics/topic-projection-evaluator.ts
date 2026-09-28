import { z } from 'zod';
import {
  QualifyingLaneSchema,
  type QualifyingLane,
} from '@mahalla-ovozi/api-contracts';
import type { AiGatewayPort } from '../ai/ai-gateway.js';
import {
  type MahallaDailySnapshot,
  type AcceptedEvidenceItem,
  formatEvidenceItemLine,
} from '../ai/context-snapshot.js';
import { AiGatewayError, type AiGatewayResult } from '../ai/types.js';
import { computeLevenshteinDistance } from './topic-matching-resolver.js';

export const QualifyingLaneEnum = QualifyingLaneSchema;
export { type QualifyingLane };

/**
 * Maximum number of target-Topic evidence items presented in the projection prompt.
 * Only the most recent items are kept (see `capTargetEvidenceForPrompt`).
 */
export const MAX_TARGET_EVIDENCE_IN_PROMPT = 15;

/**
 * Caps the target-Topic evidence list to what the prompt will actually present.
 *
 * This exists because the prompt labels the survivors "Evidence #1..#N" by their
 * position in the CAPPED list, while `anchor_evidence_index` is resolved by the
 * post-generation guardrail. If the two use different arrays, every index the model
 * returns is off by `targetEvidence.length - MAX_TARGET_EVIDENCE_IN_PROMPT`.
 * The prompt builder and the guardrail must therefore share this one function.
 */
export function capTargetEvidenceForPrompt(
  targetEvidence: AcceptedEvidenceItem[],
): AcceptedEvidenceItem[] {
  return targetEvidence.length > MAX_TARGET_EVIDENCE_IN_PROMPT
    ? targetEvidence.slice(-MAX_TARGET_EVIDENCE_IN_PROMPT)
    : targetEvidence;
}

/**
 * Validates if the given text contains authentic Uzbek Cyrillic characters.
 * Matches standard Cyrillic characters plus Uzbek specific Cyrillic letters: қ, ғ, ҳ, ў.
 * Requires Cyrillic characters to constitute at least 70% of all alphabetic characters.
 */
export function isUzbekCyrillic(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  const cyrillicMatches = text.match(/[а-яёқғҳў]/gi) || [];
  const alphabeticMatches = text.match(/[a-zа-яёқғҳў]/gi) || [];
  if (alphabeticMatches.length === 0) {
    return cyrillicMatches.length > 0;
  }
  return cyrillicMatches.length / alphabeticMatches.length >= 0.7;
}

export const TopicProjectionResultSchema = z.preprocess(
  (val: any) => {
    if (!val || typeof val !== 'object') return val;
    const copy = { ...val };

    // Deduplicate lanes ahead of validation. NOTE: `lanes` also carries a
    // `.transform` that deduplicates after `.min(1)`, so this is redundant for the
    // parsed result. It predates the current work and is left alone deliberately.
    //
    // `is_hokim_related` is no longer derived here. It is a field the model cannot
    // meaningfully validate -- it is a pure function of `lanes` -- so it is no longer
    // model-facing at all and the evaluator derives it instead. Deriving it here while
    // a `.refine` also checked it made that refine a tautology: the preprocess set
    // exactly what the refine then verified.
    if (Array.isArray(copy.lanes)) {
      copy.lanes = Array.from(new Set(copy.lanes));
    }

    return copy;
  },
  z
    .object({
      summary: z
        .string()
        .min(1)
        .describe(
          'Concise 1-2 sentence cautious Uzbek Cyrillic summary of the reported civic disruption preserving reported status, disagreements, or recurrences without meta-commentary',
        ),
      lanes: z
        .array(QualifyingLaneEnum)
        .min(1)
        .transform((l) => Array.from(new Set(l)))
        .describe(
          'Non-empty array of applicable municipal/governance lanes. Must include the immutable primaryLane of the target Topic.',
        ),
      anchor_evidence_id: z
        .string()
        .min(1)
        .describe(
          'The evidence ID of the latest self-contained meaningful report belonging strictly to the target Topic',
        ),
      anchor_evidence_index: z
        .preprocess(
          (val) =>
            val === null ||
            val === undefined ||
            val === 0 ||
            val === '0' ||
            val === '' ||
            val === 'null' ||
            val === 'none' ||
            val === 'n/a'
              ? null
              : typeof val === 'string'
                ? parseInt(val, 10)
                : val,
          z.number().int().positive().nullable(),
        )
        .optional()
        .describe('1-based index of the anchor evidence item (e.g. 1 for Evidence #1)'),
      anchor_quote: z
        .string()
        .min(1)
        .describe('Exact quotation or key excerpt from the anchor evidence item'),
      latest_meaningful_activity_timestamp: z
        .string()
        .datetime()
        .describe(
          'ISO-8601 timestamp strictly matching the originalTimestamp of an Accepted Evidence item belonging to the target Topic',
        ),
      attribution: z
        .string()
        .min(1)
        .describe(
          'Volume-aware cautious attribution (e.g. "Маҳалла фуқароси" for single report, "Маҳалла аҳолиси" or "Бир нечта фуқаролар" for multiple corroborating reports, or permitted resident username/display name)',
        ),
      latest_update: z
        .string()
        .nullable()
        .optional()
        .describe(
          'Concise 1-sentence contextual Uzbek Cyrillic synthesis of what the latest accepted message conveys in context (New Detail, Resolution, or Confirmation). Strictly null if target topic has only 1 message.',
        ),
    })
    .transform((data) => ({
      ...data,
      is_hokim_related: data.lanes.includes('HOKIM_RELATED'),
    })),
);

/**
 * The evaluator's output contract. `is_hokim_related` is DERIVED from `lanes` by the
 * schema's transform, not validated from model output -- it is a pure function of the
 * lane set, so a model echo of it could only ever disagree, never inform. The
 * projection prompt therefore no longer requests it.
 *
 * Previously a `.preprocess` set this field and a `.refine` then checked it, which made
 * that refine a tautology: the preprocess wrote exactly what the refine verified.
 */
export type TopicProjectionResult = z.infer<typeof TopicProjectionResultSchema>;

export interface TopicProjectionInput {
  topicId: string;
  primaryLane: QualifyingLane;
  generation: number;
  snapshot: MahallaDailySnapshot;
  profileId?: string;
}

export interface TopicProjectionEvaluation {
  summary: string;
  latestUpdate: string | null;
  lanes: QualifyingLane[];
  primaryLane: QualifyingLane;
  anchorEvidenceId: string;
  anchorQuote: string;
  latestMeaningfulActivityTimestamp: string;
  attribution: string;
  isHokimRelated: boolean;
  generation: number;
  aiResult: AiGatewayResult<TopicProjectionResult>;
}

export const TOPIC_PROJECTION_SYSTEM_PROMPT = `You are the Canonical Topic Projection Engine for Mahalla Ovozi, a municipal intelligence platform monitoring neighborhood Telegram groups across Uzbekistan.
Your objective is to recalculate the single, authoritative, multi-lane derived representation for a target Topic based on its Accepted Evidence and same-day Mahalla context.

======================================================================
PART I: CORE PROJECTION PRINCIPLES & GUARDRAILS
======================================================================

### 1. PRAGMATIC CORE CIVIC DISRUPTION SUMMARY (TUB MOHIYAT)
- Provide a concise 1-2 sentence summary strictly in authentic Uzbek Cyrillic.
- Focus directly on the UNDERLYING CIVIC DISRUPTION, outage, infrastructure failure, or municipal living condition reported by residents.
- When a resident posts questions, availability inquiries, or status checks for 24/7 continuous utilities (e.g., "bugun gaz keladimi?", "svet hammada o'chdimi yoki bizdami?", "chiroq bormi?", "suv keldimi?", "suv qachon keladi?"), extract the core municipal failure directly into the canonical template (e.g. "Газ таъминотида узилиш ёки босим пастлиги хабар қилинмоқда", "Электр таъминотида узилиш юз бергани хабар қилинмоқда"). NEVER generate literal question titles (e.g. NEVER write "Бугун газ келиши сўралмоқда").

- STRICT PROHIBITION OF BUREAUCRATIC FILLER & INTAKE PLACEHOLDERS:
  - NEVER describe conversational chatter, resident intentions to inquire, or administrative meta-commentary.
  - Topic Card summaries MUST ALWAYS describe an active civic disruption, supply outage, infrastructure breakdown, uncollected waste, or administrative grievance. NEVER generate summaries describing peer-to-peer tracking inquiries (e.g. asking where a garbage truck or repair brigade is), vehicle arrival questions, or contact number requests.
  - Mahalla Ovozi is an observational situational awareness platform, NOT an official government single window or ticketing intake desk.
  - You MUST NEVER use vague bureaucratic formulas, meta-commentary, or ticketing placeholders such as:
    - "...сўрови қабул қилинди" (STRICTLY FORBIDDEN)
    - "...мурожаати рўйхатга олинди" (STRICTLY FORBIDDEN)
    - "...кўриб чиқилмоқда" (STRICTLY FORBIDDEN)
    - "...аризаси олинди" (STRICTLY FORBIDDEN)
    - "...мурожаат қайд этилди" (STRICTLY FORBIDDEN)
    - "...барқарорлиги ҳақида маълумот олинмоқда" (STRICTLY FORBIDDEN)
    - "...ҳолати ўрганилмоқда" (STRICTLY FORBIDDEN)
    - "...аниқлик киритилмоқда" (STRICTLY FORBIDDEN)
    - "...муҳокама қилинмоқда" (STRICTLY FORBIDDEN)
    - "...барқарорлиги ҳақида хабар бермоқда" (STRICTLY FORBIDDEN)
    - "...маълумот алмашилмоқда" (STRICTLY FORBIDDEN)
    - "...ҳолати юзасидан маълумот олинмоқда" (STRICTLY FORBIDDEN)
  - A Topic Card is an alert to the District Hokim and municipal departments about a real-world citizen problem. Stating that "a request was received" or "information is being gathered about stability" completely obscures the citizen's actual suffering. State the core failure or grievance directly.

- CANONICAL HIGH-LEVEL OUTAGE & GRIEVANCE TEMPLATES BY LANE:
  - For communal supply/service disruptions (including inquiries and negative delivery reports like "suv kemadiku", "suv kelmadi", "gaz kemapti", "svet o'chdi"), ALWAYS use clean, high-level canonical summaries without street prefixes:
    - WATER (Supply Outage / Non-arrival / Low Pressure): "Сув таъминотида узилиш ёки босим пастлиги хабар қилинмоқда."
    - ELECTRICITY (Blackout): "Электр таъминотида узилиш юз бергани хабар қилинмоқда." (low voltage: "Электр кучланиши (вольтаж) пастлиги хабар қилинмоқда.")
    - GAS: "Газ таъминотида узилиш ёки босим пастлиги хабар қилинмоқда."
    - WASTE: "Чиқиндилар олиб кетилмагани хабар қилинмоқда."
    - HOKIM_RELATED (CAUSAL GROUNDING):
      - If the escalation/complaint stems from an unaddressed utility/infrastructure disruption or utility inaction (e.g. water, electricity, gas, waste, road) present in the target evidence or same-day Mahalla context:
        Concise template: "[Муаммо соҳаси] бўйича мутасаддилар эътиборсизлиги юзасидан ҳокимликка эътироз билдирилгани хабар қилинмоқда."
        (e.g., "Сув таъминотидаги муаммо бўйича мутасаддилар эътиборсизлиги юзасидан ҳокимликка эътироз билдирилгани хабар қилинмоқда.", or road: "Йўл таъмири бўйича мутасаддилар эътиборсизлиги юзасидан ҳокимликка эътироз билдирилгани хабар қилинмоқда.")
      - If no specific utility breakdown exists anywhere in context (pure general governance complaint):
        Concise template: "Ҳокимлик ва мутасадди идоралар фаолияти юзасидан эътироз билдирилгани хабар қилинмоқда."

- LOCATION & LANDMARK POLICY (HIGH-LEVEL OUTAGES VS. ACUTE POINT HAZARDS):
  - Communal Supply Outages (Gas, Electricity, Tap Water cuts, Waste collection):
    - DO NOT prefix or enumerate specific street names or landmarks in the summary title!
    - Different street names reported by residents belong to the same communal disruption; they are preserved in the accepted evidence items and anchor quote, NOT listed in the summary title.
  - Acute Localized Physical Hazards (Pipe Bursts / Flooding / Transformer Fires Only):
    - For dedicated acute physical emergency hazard topics (pipe leaks/bursts, sewage overflow, transformer fires):
    - When accepted evidence for that acute hazard mentions a specific street name or landmark (e.g. "Bog'zor ko'chasida", "elektroset arqasidagi ko'chada", "14-maktab yonida"):
    - Extract this landmark and prefix it in authentic Uzbek Cyrillic into the title (e.g. "Электросеть орқасидаги кўчада сув қувурининг сизиши ёки оқиб кетиши хабар қилинмоқда.", "Боғзор кўчасида сув қувурининг сизиши ёки оқиб кетиши хабар қилинмоқда.", "14-мактаб ёнида канализация тошгани хабар қилинмоқда.").
    - NEVER strip the landmark or street reference to produce a generic unlocalized template when the topic is dedicated to an acute localized physical hazard!
    - If NO location or street is mentioned anywhere in the acute hazard evidence, use: "Сув қувурининг сизиши ёки оқиб кетиши хабар қилинмоқда."

- CAUTIOUS REPORTED PROBABILITY FRAMING:
  - Citizen reports are unverified reported claims, NOT established ground truth.
  - ALWAYS use reported probability framing: "... хабар қилинмоқда", "... экани билдирилмоқда", "... эътироз билдирилмоқда", "... маълум қилинмоқда".
  - Preserve reported contradictions, disagreements, voltage fluctuations, recurrences ("яна ўчди" -> "такрорий узилиш кузатилмоқда"), and reported restoration ("чироқ ёнди" -> "таъминот тиклангани билдирилди").
  - A reported restoration must be described as reported (e.g. "Электр таъминоти тиклангани билдирилди"), NEVER asserting official resolution or closing the issue.
  - Do NOT invent Hokim recommendations, sentiment, urgency scores, or required actions.

### 2. VOLUME-AWARE ATTRIBUTION & PRIVACY
- Match attribution strictly to the volume of UNIQUE REPORTING CITIZENS (Distinct Reporting Residents):
  - If the target Topic contains evidence from a single unique resident (even across multiple messages, e.g. Citizen #1 continuing their thought), attribute to "Маҳалла фуқароси" (or permitted resident Telegram display name/username if provided). NEVER attribute reports from a single resident to "Маҳалла аҳолиси" or plural "Фуқаролар", even if there are multiple messages from that same resident.
  - If the target Topic contains corroborating evidence from 2 or more DISTINCT residents (e.g. Citizen #1 and Citizen #2), attribute to "Маҳалла аҳолиси" or "Бир нечта фуқаролар".
- NEVER include, infer, or reconstruct phone numbers.

### 3. MULTI-LANE DERIVATION
- Identify all applicable municipal/governance lanes from: WATER, ELECTRICITY, GAS, WASTE, HOKIM_RELATED.
- The target Topic's initial primaryLane is IMMUTABLE and MUST be included in the lanes array.
- HOKIM_RELATED QUALIFICATION CRITERIA:
  - Include HOKIM_RELATED if and only if at least one evidence item in the topic explicitly contains designated Hokim/Hokimiyat terms (including root terms "hokim", "hokimiyat", "hokimlik"; slang/typos/dialect "xokim", "hakim", "xakim", "hokimyat", "xokimyat", "hokimat", "xokimat", "hokim buva", "hokimbobo", "hokimimiz"; or apparatus officials "zamhokim", "hokim yordamchisi") OR is a direct contextual reply/burst continuation of such an appeal.
  - Road defects, mud, or unpaved street issues without explicit Hokim/Hokimiyat mentions must NEVER derive HOKIM_RELATED.
  - "mahalla raisi" or "oqsoqol" alone does NOT qualify for HOKIM_RELATED unless "hokim" or "hokimiyat" is explicitly named.

### 4. ANCHOR SELECTION & AUTHORITATIVE QUOTE (FOUNDATIONAL GENESIS & SELF-CONTAINED PRINCIPLE)
- The Anchor Evidence MUST be the foundational citizen report that established the Topic card, or the earliest self-contained report describing the disruption.
- CRITICAL (SELF-CONTAINED QUOTE RULE):
  - Minimal bipartite failure reports (e.g. "suv kemadiku", "suv kelmadi", "gaz yo'q", "svet o'chdi") contain both a qualified utility subject and failure predicate. They are fully self-contained meaningful descriptions and MUST be selected as anchor evidence when earliest.
  - If the earliest evidence item (e.g. Evidence #1) is an uninformative fragment or split burst part without a clear subject/service (e.g. "qachon keladi", "bizda ham", "yana o'chdi"), you MUST NOT select that vague fragment as the anchor quote. Instead, select the earliest evidence item that contains the actual self-contained description of the disruption (e.g. "suv kemadiku", "svet o'chdi", "gaz bosimi past") or quote the meaningful description of the issue.
- Subsequent follow-up messages (e.g. confirmations, emotional reactions, cynical chatter like "kemasa kereya xaloyiq", "bizda ham") are supporting timeline evidence and MUST NOT replace the meaningful disruption report as the anchor.
- "anchor_evidence_id" MUST strictly match the exact ID of that chosen evidence item.
- "anchor_quote" MUST be the exact verbatim excerpt from that chosen evidence item.

### 5. LATEST MEANINGFUL ACTIVITY TIMESTAMP
- "latest_meaningful_activity_timestamp" MUST strictly match the exact ISO-8601 originalTimestamp of an Accepted Evidence item belonging to the target Topic.
- Do NOT invent or use system/current time.

======================================================================
PART II: EMPIRICAL TELEGRAM FIELD LEARNINGS & DIALECT TRANSLATION KEYS
======================================================================
These empirical learnings guide accurate translation of colloquial Telegram complaints into canonical Cyrillic summaries without misinterpreting cultural idioms or slang.

### 6. RHETORICAL EXASPERATION, SARCASM & CYNICAL ESCALATIONS
- Residents frequently express frustration using rhetorical questions, irony, or sarcasm regarding authority intervention:
  - Examples: "hokimiyatga chiqish shartmi?", "prezidentga yozaylikmi endi?", "vodokanal uxlayaptimi?", "hech kimning ishi yo'qmi?", "biror narsa ishlaydimi o'zi?".
- IN REAL CONTEXT: These are NOT literal inquiries about administrative procedures or legal necessity, nor requests for guidance.
- They are ACTIVE EXPRESSIONS OF GRIEVANCE / DISSATISFACTION regarding service breakdown and municipal/utility inaction.
- You MUST NEVER interpret them literally (e.g. NEVER write "Ҳокимликка мурожаат қилиш зарурати юзасидан сўров қабул қилинди" or similar bureaucratic absurdities).
- Cynical hypothetical conditionals imagining other unoccurred disasters (e.g. "suv yo'q, endi svettiyam o'chirishsa balans bo'ladi") must NEVER be summarized as active secondary disruptions (e.g. do not synthesize that electricity is disrupted when only water was cut).

### 7. UZBEK COLLOQUIAL LAMENTATIONS & PAST-CONTINUOUS OUTAGE EXPRESSIONS
- Recognize colloquial expressions where residents state past continuous availability ("-ib turgandi", "-ayotgandi", "-ib turgandedi") combined with restrictive or lamenting particles ("hech bo'lmasa", "hec bumasa", "kamiga", "bor edi-da"):
  - Examples: "hech bo'lmasa suv kelib turgandi", "chiroq yonib turgandi", "gaz kelayotgandi", "hec bumasa suv keb turgandedi".
- IN REAL CONTEXT: These expressions convey that the municipal service (water, electricity, gas) was available earlier but has NOW BEEN LOST / CUT OFF.
- They MUST ALWAYS be summarized as an OUTAGE / SUPPLY DISRUPTION:
  - WATER: "Сув таъминотида узилиш юз бергани хабар қилинмоқда."
  - ELECTRICITY: "Электр таъминотида узилиш юз бергани хабар қилинмоқда."
  - GAS: "Газ таъминотида узилиш юз бергани хабар қилинмоқда."
- NEVER interpret past availability ("...kelib turgandi") literally as positive service stability or as an inquiry into supply stability!

### 8. UZBEK DIALECT HOMONYM & TARIFF/INTERMITTENCY DISAMBIGUATION
- Homonym Pair "qurimoq" (dry up/desiccate) vs "qurmoq" (build/erect):
  - Expressions like "qurib yotibdi", "uyam qurib yotoradimi endi", "kranta qurib qoldi" in water contexts express severe lack of water and parched conditions.
  - NEVER hallucinate home construction, house building ("уй қурилиши"), or private handyman services.
- Tariff and Intermittent Supply Complaints:
  - Complaints contrasting paying utility fees with erratic/absent supply (e.g. "pulini to'layotgan bo'lsak xohlagan payti bor xohlasa yo'q", "pul tulamasogam mayli tekin disek pulini tulekkan busek") MUST be summarized as a municipal supply outage and intermittency grievance:
    - WATER: "Сув таъминотида узилиш ёки беқарорлик хабар қилинмоқда."
    - GAS: "Газ таъминотида узилиш ёки босим пастлиги хабар қилинмоқда."
    - ELECTRICITY: "Электр таъминотида узилиш ёки беқарорлик хабар қилинмоқда."

### 9. CONTEXTUAL LATEST UPDATE (latest_update) DIRECTIVE
- Evaluate what the LATEST accepted evidence item conveys in context of preceding accepted messages for the target topic:
  - SINGLE-MESSAGE TOPICS: If target topic evidence has only 1 message, you MUST return "latest_update": null (the main summary already conveys the report).
  - MULTI-MESSAGE TOPICS (2 or more messages): You MUST synthesize what the latest message communicates in context into exactly 1 concise, factual sentence in authentic Uzbek Cyrillic (max 150 characters), classifying it into one of three archetypes:
    1. New Detail / Location / Hazard: If the latest message introduces a specific localized landmark, address, or hazard (e.g. "14-уй олдида кабел ёнаётгани маълум қилинди", "Боғзор кўчасида ҳам сув босими пасайгани айтилди").
    2. Status Change / Resolution: If the latest message indicates service restoration, repair arrival, or resolution (e.g. "Аҳоли электр таъминоти қайта тикланганини хабар қилди", "Сув берилгани билдирилди").
    3. Confirmation / Elaboration:
       - CRITICAL AUTHOR CONTINUITY INVARIANT:
         * SAME CITIZEN CONTINUATION: If the latest message is from the SAME citizen as the preceding message (marked as "Same citizen", e.g. Citizen #1 adding details, asking follow-up questions like "yoki bizdami faqat", or continuing their sentence), you MUST NEVER describe it as a new citizen or corroboration!
           STRICTLY FORBIDDEN: "Яна бир фуқаро узилишни тасдиқлади", "Бошқа фуқаро тасдиқлади", "Яна бир фуқаро қўшилди".
           Instead, synthesize what that same resident added, asked, or clarified (e.g. "Фуқаро муаммо бошқа хонадонларда ҳам бор-йўқлигини суриштирди", "Фуқаро хабарига қўшимча изоҳ берди", "Фуқаро вазият юзасидан қайта мурожаат қилди").
         * DISTINCT CITIZEN CORROBORATION: ONLY when the latest message is sent by a DIFFERENT citizen (different Citizen # index, e.g. Citizen #2 replying "+1", "bizda ham o'chdi", "ha to'g'ri"), synthesize it as corroboration from another resident (e.g. "Яна бир фуқаро узилишни тасдиқлади", "Бошқа бир фуқаро ҳам таъминот йўқлигини маълум қилди", "Аҳоли муаммо ҳали ҳам бартараф этилмаганини таъкидлади").
  - NEVER output conversational chat chatter, Latin/slang verbatim quotes, or bureaucratic filler in latest_update.

### OUTPUT FORMAT
Respond strictly with valid JSON conforming to the requested schema.`;

export class TopicProjectionEvaluator {
  private aiGateway: AiGatewayPort;

  constructor(aiGateway: AiGatewayPort) {
    this.aiGateway = aiGateway;
  }

  public buildUserPrompt(input: TopicProjectionInput): string {
    const sections: string[] = [];

    // Single source of truth for the evidence list the prompt presents to the model.
    // The guardrail that resolves `anchor_evidence_index` MUST use this same list,
    // otherwise 1-based indices refer to a different array than the prompt labelled.
    // (See resolveTargetEvidenceForPrompt and its use in evaluateTopicProjection.)

    // 1. Target Topic Demarcation
    sections.push(`### TARGET TOPIC TO RECALCULATE
- Topic ID: ${input.topicId}
- Primary Lane (Immutable): ${input.primaryLane}
- Generation: ${input.generation}
- Mahalla: ${input.snapshot.mahallaName}
- Calendar Day: ${input.snapshot.calendarDay}`);

    // Group snapshot evidence by topicId
    const targetEvidence: AcceptedEvidenceItem[] = [];
    const otherTopicsMap = new Map<string, { lane: string; items: AcceptedEvidenceItem[] }>();

    for (const item of input.snapshot.evidence) {
      if (item.topicId === input.topicId) {
        targetEvidence.push(item);
      } else {
        const otherId = item.topicId || `OTHER_${item.id}`;
        const existing = otherTopicsMap.get(otherId);
        if (existing) {
          existing.items.push(item);
        } else {
          otherTopicsMap.set(otherId, {
            lane: item.lane || 'UNKNOWN',
            items: [item],
          });
        }
      }
    }

    // 2. Target Topic Evidence Items
    if (targetEvidence.length > 0) {
      const cappedTargetEvidence = capTargetEvidenceForPrompt(targetEvidence);

      const authorMap = new Map<string, number>();
      let nextCitizenIndex = 1;

      const targetItemsText = cappedTargetEvidence
        .map((it, idx) => {
          const authorKey =
            it.telegramUserId || it.authorHandle || `author_unknown_${it.telegramMessageId}`;
          let citizenNum = authorMap.get(authorKey);
          let isFirst = false;
          if (citizenNum === undefined) {
            citizenNum = nextCitizenIndex++;
            authorMap.set(authorKey, citizenNum);
            isFirst = true;
          }

          const handleSuffix = it.authorHandle ? ` (${it.authorHandle})` : '';
          const authorLabel = isFirst
            ? `Citizen #${citizenNum}${handleSuffix}`
            : `Citizen #${citizenNum} (Same citizen)`;

          return formatEvidenceItemLine(it, idx, {
            prefix: `Evidence #${idx + 1}`,
            includeId: true,
            indent: '  ',
            timeLabel: 'Time',
            authorLabel,
          });
        })
        .join('\n');

      const uniqueCitizenCount = authorMap.size;
      const citizenSummary =
        uniqueCitizenCount === 1
          ? `1 unique citizen (Citizen #1)`
          : `${uniqueCitizenCount} distinct citizens`;

      sections[0] += `\n- Distinct Reporting Residents: ${citizenSummary}\n- Total Evidence Items: ${targetEvidence.length} message(s)`;

      sections.push(`### ACCEPTED EVIDENCE FOR TARGET TOPIC (${input.topicId})
${targetItemsText}`);
    } else {
      sections.push(`### ACCEPTED EVIDENCE FOR TARGET TOPIC (${input.topicId})
(No accepted evidence found for target topic)`);
    }

    // 3. Other Same-Day Topics in Mahalla (Context)
    if (otherTopicsMap.size > 0) {
      const otherSections: string[] = [];
      let otherTopicCount = 0;
      const MAX_OTHER_TOPICS = 5;
      const MAX_ITEMS_PER_OTHER_TOPIC = 2;

      for (const [otherId, group] of otherTopicsMap.entries()) {
        if (otherTopicCount >= MAX_OTHER_TOPICS) {
          otherSections.push(
            `- ...and ${otherTopicsMap.size - MAX_OTHER_TOPICS} additional same-day topics omitted for brevity.`,
          );
          break;
        }
        otherTopicCount++;

        const cappedItems =
          group.items.length > MAX_ITEMS_PER_OTHER_TOPIC
            ? group.items.slice(-MAX_ITEMS_PER_OTHER_TOPIC)
            : group.items;

        const itemsText = cappedItems
          .map((it, idx) =>
            formatEvidenceItemLine(it, idx, {
              includeId: true,
              indent: '    ',
              timeLabel: 'Time',
            }),
          )
          .join('\n');

        otherSections.push(`- Other Topic ID: ${otherId} (Lane: ${group.lane})
  Evidence:
${itemsText}`);
      }

      sections.push(`### OTHER SAME-DAY TOPICS IN MAHALLA (Context Only)
${otherSections.join('\n\n')}`);
    }

    sections.push(
      `Recalculate the canonical multi-lane projection for target Topic ${input.topicId} and return the structured JSON output.`,
    );

    return sections.join('\n\n');
  }

  public async evaluateTopicProjection(
    input: TopicProjectionInput,
  ): Promise<TopicProjectionEvaluation> {
    const targetEvidence = input.snapshot.evidence.filter(
      (e) => e.topicId === input.topicId,
    );

    if (targetEvidence.length === 0) {
      throw new AiGatewayError(
        'INVALID_OUTPUT_SEMANTICS',
        `Cannot calculate topic projection: target topic ${input.topicId} has no accepted evidence in snapshot`,
      );
    }

    const userPrompt = this.buildUserPrompt(input);

    const aiResult = await this.aiGateway.generateStructured<TopicProjectionResult>({
      operationType: 'TOPIC_DERIVED_PROJECTION',
      profileId: input.profileId,
      systemPrompt: TOPIC_PROJECTION_SYSTEM_PROMPT,
      userPrompt,
      schema: TopicProjectionResultSchema,
      schemaName: 'topic_projection_result',
    });

    const data = aiResult.data;

    // Post-generation semantic guardrails (AC 6, 7, 8, 9, 11)

    // Guardrail 1: anchor_evidence_id must belong strictly to target Topic evidence
    const validEvidenceIds = new Set(targetEvidence.map((e) => e.id));

    let resolvedAnchorEvidence: AcceptedEvidenceItem | undefined = undefined;

    // 1a. Surrogate 1-based index resolution.
    // MUST resolve against the capped list the prompt actually presented (and
    // labelled "Evidence #1..#N"), never against the full `targetEvidence` array.
    const promptTargetEvidence = capTargetEvidenceForPrompt(targetEvidence);
    if (
      typeof data.anchor_evidence_index === 'number' &&
      data.anchor_evidence_index >= 1 &&
      data.anchor_evidence_index <= promptTargetEvidence.length
    ) {
      resolvedAnchorEvidence = promptTargetEvidence[data.anchor_evidence_index - 1];
    }

    // 1b. Exact DB evidence ID match
    if (!resolvedAnchorEvidence && data.anchor_evidence_id && validEvidenceIds.has(data.anchor_evidence_id)) {
      resolvedAnchorEvidence = targetEvidence.find((e) => e.id === data.anchor_evidence_id);
    }

    // 1c. Defensive typo recovery (Levenshtein distance <= 4 on candidate evidence IDs)
    if (!resolvedAnchorEvidence && data.anchor_evidence_id) {
      let bestMatch: AcceptedEvidenceItem | null = null;
      let minDistance = Infinity;
      for (const item of targetEvidence) {
        const dist = computeLevenshteinDistance(item.id, data.anchor_evidence_id);
        if (dist < minDistance) {
          minDistance = dist;
          bestMatch = item;
        }
      }

      if (bestMatch && minDistance <= 4) {
        resolvedAnchorEvidence = bestMatch;
      }
    }

    if (!resolvedAnchorEvidence) {
      throw new AiGatewayError(
        'INVALID_OUTPUT_SEMANTICS',
        `anchor_evidence_id "${data.anchor_evidence_id}" does not belong to target topic ${input.topicId}`,
      );
    }

    // Guardrail 2: latest_meaningful_activity_timestamp must match originalTimestamp of an evidence item in target Topic
    const validTimestamps = new Set(
      targetEvidence.map((e) => {
        const d = new Date(e.originalTimestamp);
        return isNaN(d.getTime()) ? '' : d.toISOString();
      }),
    );
    const parsedDate = new Date(data.latest_meaningful_activity_timestamp);
    if (isNaN(parsedDate.getTime())) {
      throw new AiGatewayError(
        'INVALID_OUTPUT_SEMANTICS',
        `latest_meaningful_activity_timestamp "${data.latest_meaningful_activity_timestamp}" is not a valid ISO-8601 date string`,
      );
    }
    let resultTimestampIso = parsedDate.toISOString();

    if (!validTimestamps.has(resultTimestampIso)) {
      if (resolvedAnchorEvidence && targetEvidence.length === 1) {
        const fallbackDate = new Date(resolvedAnchorEvidence.originalTimestamp);
        if (!isNaN(fallbackDate.getTime())) {
          resultTimestampIso = fallbackDate.toISOString();
        }
      }
    }

    if (!validTimestamps.has(resultTimestampIso)) {
      throw new AiGatewayError(
        'INVALID_OUTPUT_SEMANTICS',
        `latest_meaningful_activity_timestamp "${data.latest_meaningful_activity_timestamp}" does not match any evidence timestamp in target topic ${input.topicId}`,
      );
    }

    // Guardrail 3: lanes must include target Topic's immutable primaryLane
    if (!data.lanes.includes(input.primaryLane)) {
      throw new AiGatewayError(
        'INVALID_OUTPUT_SEMANTICS',
        `Derived lanes [${data.lanes.join(', ')}] must include target topic's immutable primary lane "${input.primaryLane}"`,
      );
    }

    // Guardrail 4: summary must contain authentic Uzbek Cyrillic text
    if (!isUzbekCyrillic(data.summary)) {
      throw new AiGatewayError(
        'INVALID_OUTPUT_SEMANTICS',
        `Summary must contain authentic Uzbek Cyrillic characters (length: ${data.summary.length})`,
      );
    }

    // Guardrail 5: programmatic phone number check (AD-11, AC 9)
    const phoneRegex = /(?:\+?998|\b)[0-9]{9,}\b/;
    if (
      phoneRegex.test(data.summary) ||
      phoneRegex.test(data.anchor_quote) ||
      (data.attribution && phoneRegex.test(data.attribution)) ||
      (data.latest_update && phoneRegex.test(data.latest_update))
    ) {
      throw new AiGatewayError(
        'INVALID_OUTPUT_SEMANTICS',
        'Output contains forbidden phone number pattern violating privacy invariants',
      );
    }

    // Guardrail 6: programmatic prohibition of bureaucratic filler & investigative placeholders
    const bureaucraticFillerRegex =
      /(?:маълумот\s+олинмоқда|ҳолати\s+ўрганилмоқда|аниқлик\s+киритилмоқда|муҳокама\s+қилинмоқда|барқарорлиги\s+ҳақида|маълумот\s+алмашилмоқда|ҳолати\s+(?:бўйича|юзасидан)\s+маълумот)/i;
    if (bureaucraticFillerRegex.test(data.summary)) {
      throw new AiGatewayError(
        'INVALID_OUTPUT_SEMANTICS',
        `Summary contains prohibited bureaucratic filler/placeholder: "${data.summary}". Must state the core reported civic disruption directly.`,
      );
    }
    if (data.latest_update && bureaucraticFillerRegex.test(data.latest_update)) {
      throw new AiGatewayError(
        'INVALID_OUTPUT_SEMANTICS',
        `Latest update contains prohibited bureaucratic filler/placeholder: "${data.latest_update}".`,
      );
    }

    // Guardrail 7: latest_update handling and Uzbek Cyrillic validation
    let resolvedLatestUpdate: string | null = null;
    if (targetEvidence.length > 1 && data.latest_update && data.latest_update.trim().length > 0) {
      if (!isUzbekCyrillic(data.latest_update)) {
        throw new AiGatewayError(
          'INVALID_OUTPUT_SEMANTICS',
          `Latest update must contain authentic Uzbek Cyrillic characters (got: "${data.latest_update}")`,
        );
      }
      resolvedLatestUpdate = data.latest_update.trim();
    }

    return {
      summary: data.summary,
      latestUpdate: resolvedLatestUpdate,
      lanes: data.lanes,
      primaryLane: input.primaryLane,
      anchorEvidenceId: resolvedAnchorEvidence.id,
      anchorQuote: data.anchor_quote,
      latestMeaningfulActivityTimestamp: resultTimestampIso,
      attribution: data.attribution,
      isHokimRelated: data.is_hokim_related,
      generation: input.generation,
      aiResult,
    };
  }
}
