import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import {
  QualifyingLaneSchema,
  type QualifyingLane,
} from '@mahalla-ovozi/api-contracts';
import type { DbClient } from '../../adapters/db/client.js';
import { acceptedEvidence } from '../../adapters/db/schema/accepted-evidence.js';
import type { AiGatewayPort } from '../ai/ai-gateway.js';
import {
  type MahallaDailySnapshot,
  groupSnapshotByTopic,
  formatEvidenceItemLine,
} from '../ai/context-snapshot.js';
import type { TelegramReplyMetadata } from '@mahalla-ovozi/api-contracts';
import type { AiGatewayResult } from '../ai/types.js';

export const QualifyingLaneEnum = QualifyingLaneSchema;
export { type QualifyingLane };

export const TopicMatchingDecisionEnum = z.enum([
  'MATCH_EXISTING_TOPIC',
  'NEW_TOPIC',
  'UNASSIGNABLE_VAGUE',
]);
export type TopicMatchingDecision = z.infer<typeof TopicMatchingDecisionEnum>;

export const TopicMatchingResultSchema = z.preprocess(
  (val: any) => {
    if (!val || typeof val !== 'object') return val;
    const copy = { ...val };
    if (typeof copy.reasoning === 'string' && copy.reasoning.length > 300) {
      copy.reasoning = copy.reasoning.slice(0, 300);
    }

    // Coerce 0, "0", null, negative numbers or non-positive indices to null
    if (
      copy.matched_topic_index === 0 ||
      copy.matched_topic_index === '0' ||
      copy.matched_topic_index === null ||
      copy.matched_topic_index === undefined
    ) {
      copy.matched_topic_index = null;
    } else if (typeof copy.matched_topic_index === 'string' && /^-?\d+$/.test(copy.matched_topic_index)) {
      const parsed = parseInt(copy.matched_topic_index, 10);
      copy.matched_topic_index = parsed > 0 ? parsed : null;
    } else if (typeof copy.matched_topic_index === 'number') {
      if (copy.matched_topic_index <= 0) {
        copy.matched_topic_index = null;
      }
    }

    // Coerce empty strings, "null", "none", "n/a" for matched_topic_id to null
    if (typeof copy.matched_topic_id === 'string') {
      const trimmed = copy.matched_topic_id.trim();
      if (
        trimmed === '' ||
        trimmed.toLowerCase() === 'null' ||
        trimmed.toLowerCase() === 'none' ||
        trimmed.toLowerCase() === 'n/a'
      ) {
        copy.matched_topic_id = null;
      }
    }

    // Enforce the decision-implied shape of the payload before the refine checks it.
    // The model routinely echoes fields the chosen decision does not admit; the refine
    // below is the contract, so the coercion that keeps it satisfiable belongs here,
    // next to the schema that owns it, rather than in the provider-neutral gateway.
    if (copy.decision === 'MATCH_EXISTING_TOPIC') {
      copy.primary_lane = null;
    } else if (copy.decision === 'NEW_TOPIC') {
      copy.matched_topic_id = null;
    } else if (copy.decision === 'UNASSIGNABLE_VAGUE') {
      copy.matched_topic_id = null;
      copy.primary_lane = null;
    }

    return copy;
  },
  z
    .object({
      decision: TopicMatchingDecisionEnum.describe(
        'Whether the candidate matches an existing same-day Topic (MATCH_EXISTING_TOPIC), seeds a new independent Topic (NEW_TOPIC), or is an unassignable vague fragment (UNASSIGNABLE_VAGUE)',
      ),
      matched_topic_id: z
        .string()
        .nullable()
        .optional()
        .describe(
          'Canonical topic ID (e.g. top_...) if decision is MATCH_EXISTING_TOPIC, otherwise null',
        ),
      matched_topic_index: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe(
          '1-based index of matched topic from the prompt list (e.g. 1, 2) if decision is MATCH_EXISTING_TOPIC, otherwise null',
        ),
      primary_lane: QualifyingLaneEnum.nullable().describe(
        'Primary municipal service or leadership lane (WATER, ELECTRICITY, GAS, WASTE, HOKIM_RELATED) if decision is NEW_TOPIC, otherwise null',
      ),
      reasoning: z
        .string()
        .max(300)
        .describe('Brief 1-sentence explanation of topic assignment decision'),
    })
    .refine(
      (data) => {
        if (data.decision === 'MATCH_EXISTING_TOPIC') {
          const hasId = typeof data.matched_topic_id === 'string' && data.matched_topic_id.trim().length > 0;
          const hasIndex = typeof data.matched_topic_index === 'number' && data.matched_topic_index > 0;
          return (hasId || hasIndex) && data.primary_lane === null;
        }
        if (data.decision === 'NEW_TOPIC') {
          const noId = data.matched_topic_id === null || data.matched_topic_id === undefined;
          const noIndex = data.matched_topic_index === null || data.matched_topic_index === undefined;
          return noId && noIndex && data.primary_lane !== null;
        }
        if (data.decision === 'UNASSIGNABLE_VAGUE') {
          const noId = data.matched_topic_id === null || data.matched_topic_id === undefined;
          const noIndex = data.matched_topic_index === null || data.matched_topic_index === undefined;
          return noId && noIndex && data.primary_lane === null;
        }
        return false;
      },
      {
        message:
          'Inconsistent topic matching output: MATCH_EXISTING_TOPIC requires matched_topic_id or matched_topic_index and null primary_lane; NEW_TOPIC requires null matched_topic_id/index and non-null primary_lane; UNASSIGNABLE_VAGUE requires null for both',
      },
    ),
);

export type TopicMatchingResult = z.infer<typeof TopicMatchingResultSchema>;


export interface EvaluateTopicAssignmentInput {
  candidateText: string;
  telegramMessageId: string;
  telegramUserId?: string;
  authorHandle?: string;
  originalTimestamp: string;
  contentType: 'TEXT' | 'MEDIA_CAPTION';
  replyMetadata: TelegramReplyMetadata | null;
  relevantLanes: QualifyingLane[];
  relevanceReasoning?: string;
  snapshot: MahallaDailySnapshot;
  profileId?: string;
}

/**
 * Direct Telegram Reply Fast Matcher (AC 2, 3 / Pure DB resolution)
 * Searches accepted_evidence for the parent message matching the candidate's reply target
 * within the exact same district, mahalla, calendar day, and Telegram chat.
 * Returns the parent's canonical topicId if found, or null otherwise.
 */
export async function findDirectReplyTopic(
  db: DbClient,
  districtId: string,
  mahallaName: string,
  calendarDay: string,
  telegramChatId: string,
  replyToMessageId: string,
): Promise<string | null> {
  const [parentRecord] = await db
    .select({ topicId: acceptedEvidence.topicId })
    .from(acceptedEvidence)
    .where(
      and(
        eq(acceptedEvidence.districtId, districtId),
        eq(acceptedEvidence.telegramChatId, telegramChatId),
        eq(acceptedEvidence.telegramMessageId, replyToMessageId),
        eq(acceptedEvidence.mahallaName, mahallaName),
        eq(acceptedEvidence.calendarDay, calendarDay),
      ),
    )
    .limit(1);

  return parentRecord?.topicId ?? null;
}

export const TOPIC_MATCHING_SYSTEM_PROMPT = `You are the Topic Assignment & Clustering Engine for Mahalla Ovozi, an AI platform monitoring neighborhood Telegram groups in Uzbekistan.
Your objective is to evaluate relevance-qualified candidate messages and assign them to an existing same-day Mahalla Topic or seed a new independent Topic.

======================================================================
PART I: CORE CLUSTERING & DOMAIN INVARIANTS
======================================================================

### 1. FOUNDATIONAL INVARIANT: HIGH-LEVEL COMMUNAL TOPICS VS. ACUTE PHYSICAL HAZARDS
- A Topic represents a single, continuous, real-world incident, supply outage, or civic situation in this Mahalla on this calendar day.
- COMMUNAL UTILITY & SERVICE DISRUPTIONS ARE MAHALLA-WIDE (LOCATION-AGNOSTIC):
  - In a Mahalla, public utility networks and municipal services (Gas supply/pressure, Electricity grid/voltage, Tap water supply/pressure, Municipal garbage truck routes) are communal infrastructure.
  - When a GENERAL SUPPLY OUTAGE or disruption occurs, residents across different streets (e.g. Street A, Street B) or without any street name are reporting the SAME overarching communal disruption.
  - Street names, landmarks, or lack of address in supply outage reports are SPATIAL DETAILS / EVIDENCE, NOT indicators of separate incidents!
  - You MUST NOT create separate topics simply because residents name different streets when reporting the same general utility disruption.
- BUT: ACUTE PHYSICAL ASSET HAZARDS ARE STRICTLY ISOLATED FROM GENERAL SUPPLY OUTAGES (CRITICAL INVARIANT):
  - A physical infrastructure breach, rupture, leak, or fire hazard (e.g. a broken water pipe flooding a street, an overflowing sewage manhole, an exploding transformer or downed live wire, a leaking/ruptured gas line) is an acute localized point emergency.
  - IT HAS AN INCOMPATIBLE FAILURE PREDICATE FROM QUIET HOUSEHOLD SUPPLY OUTAGES AND MUST NEVER BE MERGED INTO A GENERAL SUPPLY OUTAGE TOPIC!

### 2. DECISION TAXONOMY & STRICT CONTRACTS
1. MATCH_EXISTING_TOPIC:
   - The candidate reports service loss, outages, pressure/voltage fluctuations, updates, inquiries, restoration reports, recurrences, or confirmations concerning the active communal outage or existing incident in this Mahalla in the same service lane.
   - Format: "decision": "MATCH_EXISTING_TOPIC", "matched_topic_index": <1-based index e.g. 1>, "matched_topic_id": "<existing_topic_id>", "primary_lane": null.
2. NEW_TOPIC:
   - The candidate seeds the first topic for this service lane in the Mahalla today; OR
   - The candidate reports an acute, distinct physical infrastructure hazard with an incompatible failure predicate (e.g. an active pipe rupture flooding a street vs dry tap water shutoff; a sparking/exploding transformer or fallen wire vs quiet grid blackout).
   - Format: "decision": "NEW_TOPIC", "matched_topic_id": null, "primary_lane": "<LANE>".
   - STRICT UPSTREAM LANE CONSTRAINT: primary_lane MUST strictly be chosen from the candidate's upstream Relevant Lanes provided in the prompt. You MUST NEVER select a primary_lane that is not present in the candidate's Relevant Lanes!
3. UNASSIGNABLE_VAGUE:
   - The candidate is an isolated, subjectless conversational fragment without a clear link to any active topic; OR
   - The candidate is an operational vehicle tracking inquiry ("musor mashina qaysi ko'chada?"), routine schedule/ETA check without failure, or standalone contact lookup without an active disruption report. Such messages MUST NOT seed new topics nor attach to existing topics; OR
   - The candidate discusses private domestic errands, handyman/craftsman hire ("santexnik kerak", "usta kerak"), private house construction/renovation, scrap recycling ("bakalashka oladigan nomeri"), or private transport/debris hauling ("remont chiqindisiga muravey bormi"). Such messages MUST NOT be merged into active municipal topics nor seed new topics; OR
   - UNANCHORED DEPENDENT FRAGMENTS & NON-TOPIC REPLIES:
     If the candidate is an ambiguous dependent fragment or inquiry lacking an independent municipal subject (e.g. "qayerda ekan", "bizga kerak", "qachon keladi", "nima bo'ldi"), AND its reply_to_message_id does NOT belong to any active accepted topic in the mahalla snapshot:
     You MUST classify it as UNASSIGNABLE_VAGUE!
     You are STRICTLY FORBIDDEN from force-merging unanchored ambiguous fragments into an existing topic just because that topic happens to be the only active topic of the day in the mahalla!
   - AUTHOR CONTINUITY EXCEPTION FOR UNANCHORED FOLLOW-UPS:
     If the candidate is an unanchored dependent follow-up or grievance fragment (e.g. "nme pul olepti vaqtida kemasa", "biz bilme qoldkmi") lacking an independent municipal subject or direct reply target, BUT was sent by the SAME resident who already reported or contributed to an active same-day Topic in that lane today (marked [SAME AUTHOR AS CANDIDATE] in Accepted Evidence):
     You MUST classify it as MATCH_EXISTING_TOPIC (assigning to that author's existing topic), UNLESS it asserts a distinct acute physical infrastructure hazard with an incompatible failure predicate.
     It is STRICTLY FORBIDDEN to designate same-author follow-up grievances as UNASSIGNABLE_VAGUE when their active topic exists!
   - MINIMAL BIPARTITE DISRUPTION REPORTS MUST NEVER BE UNASSIGNABLE_VAGUE:
     A message asserting a minimal bipartite civic disruption ([utility subject] + [failure/non-arrival predicate], e.g. "suv kemadiku", "suv kelmadi", "gaz yo'q", "svet o'chdi") possesses a clear qualifying municipal lane. Because communal utility networks in a mahalla are location-agnostic, it MUST be assigned to MATCH_EXISTING_TOPIC (if an active topic in that lane exists) or NEW_TOPIC (if seeding the first topic of the day). It is STRICTLY FORBIDDEN to designate minimal bipartite disruption messages as UNASSIGNABLE_VAGUE!
   - RELEVANCE-QUALIFIED CITIZEN COPING PROPOSALS & WORKAROUNDS:
     When a candidate has been qualified upstream by Semantic Relevance as a citizen coping proposal, workaround, or self-help initiative (e.g. proposing an informal waste dump point because the municipal truck is unserved: "Bitta obshiy to'kadigan joy qilganimiz yaxshimasmikan undan ko'ra... zato qachon kelarkan deb kutib o'tirmaymiz perejivat qilib"; or proposing a shared water pump/generator/firewood due to utility failure):
     Such messages possess a verified municipal Lane qualification (e.g. WASTE, WATER, ELECTRICITY, GAS) derived from the underlying service breakdown.
     - If an active Topic in that service lane already exists today: Assign as MATCH_EXISTING_TOPIC.
     - If NO active Topic exists in that lane today: Seed a NEW_TOPIC with primary_lane set to that qualified service lane.
     - STRICT PROHIBITION: You MUST NEVER designate relevance-qualified citizen coping proposals or workarounds as UNASSIGNABLE_VAGUE!
   - Format: "decision": "UNASSIGNABLE_VAGUE", "matched_topic_id": null, "primary_lane": null.

### 3. DOMAIN BOUNDARIES & HOKIM_RELATED CAUSAL CONSOLIDATION
- Incident Semantic Relevance Precedence (Municipal Disruption vs. Private Peer Requests): An active Topic represents a PUBLIC MUNICIPAL / COMMUNAL issue or disruption. Private peer-to-peer requests must never be attached to public topics (designate UNASSIGNABLE_VAGUE). Municipal utility outages, intermittent supply, and tariff grievances are communal and must be clustered into their respective service lanes.
- HOKIM_RELATED is strictly reserved for civic complaints, grievances, or problem reports explicitly addressed to or demanding action from the District Hokim or Hokimiyat (tuman/shahar hokimi, hokimlik, hokim yordamchisi), and their direct thread follow-ups.
- Causal Domain Aggregation for HOKIM_RELATED:
  - Hokim complaints in the same Mahalla on the same day that address the SAME underlying grievance domain merge into a single high-level topic regardless of different street names:
    - All road defects, mud, potholes, and unpaved street complaints addressed to the Hokim merge into one high-level Hokim road topic.
    - Utility-inaction escalations to the Hokim merge into the Hokim escalation topic for that domain.
    - General governance and administration complaints merge into one general governance topic.
- Messages that do NOT address or criticize the Hokim/Hokimiyat MUST NEVER be assigned to or matched into HOKIM_RELATED.
- You MUST NEVER match a message across different service lanes (e.g. water outage cannot merge into electricity topic).

### 4. CLUSTERING RULES & MULTI-INCIDENT DISAMBIGUATION
1. Same-Day Community-Wide Outage Consolidation (Location-Agnostic):
   - For general public utility SUPPLY DEFICITS (GAS pressure/cut, ELECTRICITY blackout/voltage drop, TAP WATER shutoff/dry taps, WASTE missed collection), all reports of supply cuts, outages, pressure drops, voltage instability, or missed municipal collection in the same lane MUST merge into the active general lane topic (MATCH_EXISTING_TOPIC).
   - This applies REGARDLESS of whether different residents name Street A, Street B, or no address at all.
   - Same-day inquiries ("suv keldimi?", "bugun gaz keladimi?", "chiroq yondimi?", "svet bo'ladimi?"), negative delivery reports ("suv kemadiku", "suv kelmadi", "gaz kemapti"), sarcastic/rhetorical reports ("gazni bayramga berishadimi?"), recurrences ("yana o'chdi"), or restoration reports belong to this ongoing general topic, even after several hours of silence.

2. Acute Physical Point Hazards vs. General Supply Outages (STRICT MUTUALLY EXCLUSIVE PARTITION):
   - Utility lanes contain two mutually exclusive failure predicate classes:
     * CLASS A (Supply Deficit / Outage): "suv yo'q", "suvam quridi", "suv kemadi", "svet o'chdi", "chiroq yo'q", "gaz o'chdi", "gaz past". Managed by network supply dispatchers.
     * CLASS B (Physical Asset Breach / Point Hazard / Flooding / Fire): "suv oqib yotibdi / yotipti", "truba yorildi / teshildi", "ko'chani suv bosdi", "lyuk toshdi", "daryo bo'lib ketdi", "gaz sizib chiqishi / hidi", "transformator portladi / yondi", "sim uzilib tushdi". Managed by emergency field repair brigades (Avariya guruhi).
   - STRICT ANTI-CAUSAL SPECULATION MANDATE:
     * YOU ARE STRICTLY FORBIDDEN FROM SPECULATING A CAUSAL LINK BETWEEN CLASS A AND CLASS B!
     * Never assume or reason that a street water pipe leak/burst is "the underlying cause of", "related to", or "part of" the household tap water outage in the neighborhood!
     * Even if a street pipe leak and a household water shutoff occur in the same mahalla on the same day, they MUST REMAIN SEPARATE TOPICS!
     * A report of an acute physical hazard (Class B) MUST ALWAYS seed a dedicated NEW_TOPIC (or merge into an existing dedicated acute hazard topic for that same physical incident). It MUST NEVER be merged into a Class A general supply outage topic!
   - TEMPORAL & SPATIAL DISCONNECT:
     * When a resident describes a localized street leak ("suv oqib yotipti 2 kundan beri tog kucada"), the multi-day duration and street location explicitly distinguish it from same-day household tap water shutoffs. Direct follow-ups concerning the leak ("daryo bub ketadiyov", "vodokanaldegilaga aytish kere") attach to the hazard topic, NEVER to the supply outage topic.

3. Chat Silence & Multi-Incident Disambiguation for Localized Follow-ups:
   - Within 30 minutes of chat activity: Match to the topic of the immediate preceding recent message (N-1 in chat).
   - After >30 minutes of chat silence: When multiple localized physical incident topics exist in the same lane and a follow-up does not name a street or landmark, The AI MUST NOT guess between the two localized streets -> classify as UNASSIGNABLE_VAGUE.

======================================================================
PART II: EMPIRICAL TELEGRAM FIELD LEARNINGS & DISAMBIGUATION KEYS
======================================================================
These empirical rules capture real-world communication patterns in neighborhood Telegram groups. Use them to resolve dialect ambiguities and distinguish authentic civic complaints from private noise during clustering.

### 5. CRITICAL DISTINCTION (MUNICIPAL PERSONNEL & TARIFF GRIEVANCES VS. PRIVATE HANDYMEN)
- Mentions of municipal utility workers or question particles ("suvchi", "gazchi", "svetchi", "musorchi"), utility payment complaints ("pulini to'layotgan bo'lsak, xohlagan payti bor xohlasa yo'q", "pul tulamasogam mayli tekin disek pulini tulekkan busek"), or dialectal desiccation ("qurib yotibdi", "uyam qurib yotadimi") represent PUBLIC MUNICIPAL SIGNALS, NEVER private handyman errands.
- Minimal bipartite delivery failure reports ("suv kemadiku", "suv kelmadi", "gaz kemapti", "svet o'chdi", "musor kelmadi") with or without modal particles represent communal supply failures.
- They MUST be assigned to their qualifying lane (MATCH_EXISTING_TOPIC or NEW_TOPIC), NEVER designated as UNASSIGNABLE_VAGUE.
- Contrast with genuine private requests: "santexnik kerak", "usta kerak", "boyler tuzatadigan odam bormi" -> private errands that are UNASSIGNABLE_VAGUE.

### 6. SPATIAL ORIENTIRS & LANDMARK DISAMBIGUATION (CRITICAL EXCEPTION (SPATIAL ORIENTIRS / ADDRESSES))
- Utility enterprise names (e.g. "Elektroset/Elektrosvet/REO", "Vodokanal/Suvokova", "Raygaz/Gorkaz") combined with spatial/locational markers ('orqasi', 'orqa tarafi', 'yoni', 'ro'parasi', 'oldi', 'ko'chasi', 'garaj tarafi', 'tarafideyi kucagayam') designate a PHYSICAL LANDMARK / ADDRESS (MANZIL / MO'LJAL). They do NOT represent a service disruption of that utility!
- For example, "elektrosvet orqa tarafideyi kucagayam kesin" in a waste context requests the municipal garbage truck to service the street behind the electric utility office. This belongs strictly to WASTE (per upstream Relevant Lanes), NEVER ELECTRICITY!
- MUST strictly be chosen from the candidate's upstream Relevant Lanes.

### 7. CULTURAL EXPRESSIONS, RHETORICAL QUESTIONS & BURST SPLITS IN CLUSTERING
- Rhetorical questions ("chiroq ko'ramizmi o'zi bugun?", "gaz bayramgami?"), negative delivery statements ("suv kemadiku", "gaz kemapti"), and multi-message bursts (e.g. Message 1: "suvchi", Message 2: "uyam qurib yotoradimi endi") that passed upstream semantic relevance represent communal outages in that lane.
- In clustering, these messages consolidate into the active same-day communal Topic for that lane (MATCH_EXISTING_TOPIC) or seed the first communal topic (NEW_TOPIC).
- Do NOT isolate them as UNASSIGNABLE_VAGUE when they reflect the ongoing communal outage.
- Sarcastic hypothetical conditionals imagining unoccurred outages ("svettiyam o'chirishsa endi") must NEVER seed an unverified topic or bridge across service lanes. Clustering strictly conforms to the upstream validated Relevant Lanes.

### OUTPUT FORMAT
Respond strictly with valid JSON conforming to the requested schema.`;

export class TopicMatchingEvaluator {
  private aiGateway: AiGatewayPort;

  constructor(aiGateway: AiGatewayPort) {
    this.aiGateway = aiGateway;
  }

  public buildUserPrompt(input: EvaluateTopicAssignmentInput): string {
    const sections: string[] = [];

    // 1. Candidate message
    const authorHeader = input.authorHandle || input.telegramUserId
      ? `\n- Author: [${input.authorHandle || input.telegramUserId}]`
      : '';

    sections.push(`### CANDIDATE RELEVANT TELEGRAM MESSAGE TO ASSIGN
- Message ID: ${input.telegramMessageId}${authorHeader}
- Timestamp: ${input.originalTimestamp}
- Content Type: ${input.contentType}
- Relevant Lanes: [${input.relevantLanes.join(', ')}]
${input.relevanceReasoning ? `- Relevance Reasoning: "${input.relevanceReasoning}"` : ''}
- Verbatim Text: "${input.candidateText}"`);

    // 2. Reply Context (if any)
    if (input.replyMetadata) {
      if (input.replyMetadata.replyToIsForwarded) {
        sections.push(`### REPLY CONTEXT
- Note: Message replies to a forwarded message which was excluded. Evaluate candidate on its own merit against existing same-day topics.`);
      } else {
        sections.push(`### REPLY CONTEXT
- Reply Target Message ID: ${input.replyMetadata.replyToMessageId} (Target was not found in active accepted evidence or was cross-day/cross-district; evaluate via same-day topic matching).`);
      }
    }

    // 3. Existing Same-Day Topics and Evidence Context
    if (input.snapshot.evidence.length > 0) {
      // Group evidence items by topicId
      const topicMap = groupSnapshotByTopic(input.snapshot);

      const topicSections: string[] = [];
      let topicIndex = 1;
      for (const [topicId, group] of topicMap.entries()) {
        const itemsText = group.items
          .map((it, idx) => {
            const isCurrentSender = Boolean(
              input.telegramUserId && it.telegramUserId && input.telegramUserId === it.telegramUserId,
            );
            return formatEvidenceItemLine(it, idx, {
              indent: '    ',
              timeLabel: 'Time',
              includeAuthor: true,
              authorTag: isCurrentSender ? 'SAME AUTHOR AS CANDIDATE' : undefined,
            });
          })
          .join('\n');

        const cleanSummary = group.summary?.trim().replace(/\n/g, ' ');
        const initialExcerpt = group.items[0]?.verbatimText
          ? `(Initial report: "${group.items[0].verbatimText.slice(0, 100).replace(/\n/g, ' ')}")`
          : '';
        const summaryDisplay = cleanSummary ? `"${cleanSummary}"` : initialExcerpt;
        const summaryLine = summaryDisplay ? `\n  Current Topic Summary: ${summaryDisplay}` : '';

        topicSections.push(`- [Topic #${topicIndex}] ID: ${topicId} (Primary Lane: ${group.lane})${summaryLine}
  Accepted Evidence:
${itemsText}`);
        topicIndex++;
      }

      // Identify nearest earlier message
      const candidateTime = new Date(input.originalTimestamp).getTime();
      const earlierItems = input.snapshot.evidence.filter(
        (e) => new Date(e.originalTimestamp).getTime() <= candidateTime,
      );
      const nearestEarlier = earlierItems[earlierItems.length - 1];

      let nearestText = '';
      if (nearestEarlier) {
        const prevTime = new Date(nearestEarlier.originalTimestamp).getTime();
        const diffMinutes = !Number.isNaN(prevTime) && !Number.isNaN(candidateTime)
          ? Math.round((candidateTime - prevTime) / 60000)
          : null;
        const diffText = diffMinutes !== null ? ` (+${diffMinutes}m before candidate)` : '';
        nearestText = `\nNearest Earlier Same-Day Message in Mahalla: MsgID ${nearestEarlier.telegramMessageId}${diffText} (Topic: ${nearestEarlier.topicId || 'N/A'}, Time: ${nearestEarlier.originalTimestamp}): "${nearestEarlier.verbatimText}"\n`;
      }

      sections.push(`### EXISTING SAME-DAY TOPICS & EVIDENCE (Mahalla: ${input.snapshot.mahallaName}, Day: ${input.snapshot.calendarDay})
${nearestText}
${topicSections.join('\n\n')}`);
    } else {
      sections.push(`### EXISTING SAME-DAY TOPICS & EVIDENCE (Mahalla: ${input.snapshot.mahallaName}, Day: ${input.snapshot.calendarDay})
(No active topics or accepted evidence recorded yet today in this Mahalla)`);
    }

    sections.push(
      `Evaluate the candidate message above and return the topic matching decision conforming to the schema. When matching an existing topic, provide its matched_topic_index (e.g. 1) or matched_topic_id.`,
    );

    return sections.join('\n\n');
  }

  public async evaluateTopicAssignment(
    input: EvaluateTopicAssignmentInput,
  ): Promise<AiGatewayResult<TopicMatchingResult>> {
    const userPrompt = this.buildUserPrompt(input);

    return this.aiGateway.generateStructured<TopicMatchingResult>({
      operationType: 'TOPIC_MATCHING',
      profileId: input.profileId,
      systemPrompt: TOPIC_MATCHING_SYSTEM_PROMPT,
      userPrompt,
      schema: TopicMatchingResultSchema,
      schemaName: 'topic_matching_result',
    });
  }
}
