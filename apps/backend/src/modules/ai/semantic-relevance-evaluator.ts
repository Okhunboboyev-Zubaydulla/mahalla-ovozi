import { z } from 'zod';
import {
  QualifyingLaneSchema,
  type QualifyingLane,
} from '@mahalla-ovozi/api-contracts';
import type { AiGatewayPort } from './ai-gateway.js';
import {
  type MahallaDailySnapshot,
  type AcceptedEvidenceItem,
  formatSnapshotForSemanticRelevance,
} from './context-snapshot.js';
import type { TelegramReplyMetadata, BurstMessageItem } from '../../adapters/jobs/job-types.js';
import type { AiGatewayResult } from './types.js';
import { SEMANTIC_RELEVANCE_SYSTEM_PROMPT } from './ai-config.js';

export const QualifyingLaneEnum = QualifyingLaneSchema;
export type { QualifyingLane };

export const ExclusionReasonEnum = z.enum([
  'PLANNED_ANNOUNCEMENT',
  'ADVERTISEMENT_OR_SPAM',
  'SPECULATION_OR_RUMOR',
  'NEUTRAL_OR_PRAISE',
  'GENERAL_CHATTER',
  'UNRESOLVED_AMBIGUOUS_FRAGMENT',
]);
export type ExclusionReason = z.infer<typeof ExclusionReasonEnum>;

export const SemanticRelevanceResultSchema = z.preprocess(
  (val: any) => {
    if (!val || typeof val !== 'object') return val;
    const copy = { ...val };

    // Tolerate model quirks before validation. This coercion previously lived in
    // ai-gateway.ts, ahead of safeParse, which made the refine below unreachable in
    // production; it belongs next to the schema that declares these fields.
    if (typeof copy.reasoning === 'string' && copy.reasoning.length > 300) {
      copy.reasoning = copy.reasoning.slice(0, 300);
    }
    if (copy.is_relevant === true && copy.exclusion_reason !== null) {
      copy.exclusion_reason = null;
    } else if (
      copy.is_relevant === false &&
      Array.isArray(copy.relevant_lanes) &&
      copy.relevant_lanes.length > 0
    ) {
      copy.relevant_lanes = [];
    }

    return copy;
  },
  z
    .object({
      is_relevant: z.boolean().describe('Whether the message reports a genuine, active citizen issue or Hokim concern'),
      relevant_lanes: z.array(QualifyingLaneEnum).describe('Municipal service or leadership lanes applicable to the issue'),
      exclusion_reason: ExclusionReasonEnum.nullable().describe('Specific exclusion reason if is_relevant is false, otherwise null'),
      accepted_message_ids: z
        .array(z.string())
        .default([])
        .describe(
          'Telegram message IDs from the evaluated candidate/burst that directly report or provide spatial/temporal evidence for the civic issue. Exclude unrelated chatter or private remarks.',
        ),
      reasoning: z.string().max(300).describe('Brief 1-sentence explanation of the decision'),
    })
    .refine(
      (data) => {
        if (data.is_relevant) {
          return data.relevant_lanes.length > 0 && data.exclusion_reason === null;
        } else {
          return data.relevant_lanes.length === 0 && data.exclusion_reason !== null;
        }
      },
      {
        message:
          'Inconsistent semantic relevance output: is_relevant=true requires at least one lane and null exclusion_reason; is_relevant=false requires empty lanes and non-null exclusion_reason',
      },
    ),
);

export type SemanticRelevanceResult = z.infer<typeof SemanticRelevanceResultSchema>;

export interface PrecedingMessageContext {
  telegramMessageId: string;
  telegramUserId?: string | null;
  originalTimestamp: string;
  verbatimText: string;
  lane?: string | null;
}

export interface ChatContinuityContext {
  interveningCount: number;
  precedingRelevantMessage?: PrecedingMessageContext | null;
}

export interface ParentReplyContext {
  parentMessageId: string;
  parentStatus: 'RELEVANT' | 'EXCLUDED' | 'NOT_FOUND' | 'PENDING';
  parentExclusionReason?: string | null;
  parentVerbatimText?: string | null;
}

export interface EvaluateRelevanceInput {
  candidateText: string;
  telegramMessageId: string;
  telegramUserId?: string;
  authorHandle?: string;
  originalTimestamp: string;
  contentType: 'TEXT' | 'MEDIA_CAPTION';
  replyMetadata: TelegramReplyMetadata | null;
  snapshot: MahallaDailySnapshot;
  burstMessages?: BurstMessageItem[];
  authorPriorEvidence?: AcceptedEvidenceItem[];
  vocabularyGuidance?: string[];
  profileId?: string;
  immediatePrecedingMessage?: PrecedingMessageContext | null;
  chatContinuity?: ChatContinuityContext | null;
  parentReplyContext?: ParentReplyContext | null;
}

export { SEMANTIC_RELEVANCE_SYSTEM_PROMPT };

export class SemanticRelevanceEvaluator {
  private aiGateway: AiGatewayPort;

  constructor(aiGateway: AiGatewayPort) {
    this.aiGateway = aiGateway;
  }

  public buildUserPrompt(input: EvaluateRelevanceInput): string {
    const sections: string[] = [];
    const authorHeader = input.authorHandle || input.telegramUserId
      ? `\n- Author: [${input.authorHandle || input.telegramUserId}]`
      : '';

    if (input.burstMessages && input.burstMessages.length > 1) {
      const itemsList = input.burstMessages
        .map(
          (m, idx) =>
            `- Message #${idx + 1} (ID: ${m.telegramMessageId}, Time: ${m.originalTimestamp}): "${m.verbatimText}"`,
        )
        .join('\n');

      sections.push(`### CANDIDATE MESSAGE BURST (${input.burstMessages.length} CONSECUTIVE MESSAGES FROM SAME SENDER)${authorHeader}
${itemsList}

CRITICAL: Scrutinize each message individually. In "accepted_message_ids", list ONLY the message IDs that actually describe the municipal problem or provide vital spatial/temporal details (e.g. street address, outage confirmation). Do NOT include unrelated chatter, jokes, or non-signal messages (e.g. "Katyol bor", "Gaz girpi bor").`);
    } else {
      sections.push(`### CANDIDATE TELEGRAM MESSAGE TO EVALUATE
- Message ID: ${input.telegramMessageId}${authorHeader}
- Timestamp: ${input.originalTimestamp}
- Content Type: ${input.contentType}
- Text: "${input.candidateText}"`);
    }

    if (input.authorPriorEvidence && input.authorPriorEvidence.length > 0) {
      const authorReports = input.authorPriorEvidence
        .map((ev, idx) => {
          const laneStr = ev.lane ? `Lane: [${ev.lane}]` : 'Lane: [Unknown]';
          const topicStr = ev.topicId ? ` | Topic: ${ev.topicId}` : '';
          return `- Report #${idx + 1} (MsgID: ${ev.telegramMessageId}, Time: ${ev.originalTimestamp} | ${laneStr}${topicStr}): "${ev.verbatimText}"`;
        })
        .join('\n');

      sections.push(`### AUTHOR'S PRIOR SAME-DAY CIVIC CONTEXT (SAME SENDER)
The candidate sender previously posted the following accepted civic disruption report(s) today in this Mahalla:
${authorReports}

- CONTEXTUAL CONTINUITY: This prior context establishes the sender's active civic problem thread. If the candidate message expresses an ongoing grievance, tariff/fee dispute (e.g. disputing service fee when municipal utility failed to arrive), non-arrival complaint, or status check related to their prior report, it qualifies as RELEVANT in that lane even if intervening chat messages occurred or explicit utility keywords are omitted in this sentence.
- BOUNDARY: The candidate must express an active municipal failure, grievance, or service fee dispute. Pure domestic chatter ("ovqat tayyormi"), greetings ("salom"), or private sales inquiries remain EXCLUDED.`);
    }

    if (input.parentReplyContext && input.parentReplyContext.parentStatus === 'EXCLUDED') {
      const parentReason = input.parentReplyContext.parentExclusionReason || 'NON_CIVIC_CHAT';
      const excerpt = input.parentReplyContext.parentVerbatimText
        ? `\n- Parent Verbatim Text: "${input.parentReplyContext.parentVerbatimText.slice(0, 150)}"`
        : '';
      sections.push(`### REPLY CONTEXT (PARENT IS CONFIRMED NON-CIVIC MESSAGE)
- Reply To Message ID: ${input.parentReplyContext.parentMessageId} (Status: EXCLUDED / ${parentReason})${excerpt}
- CRITICAL ISOLATION RULE: The parent message is a non-civic chat/ad. The candidate MUST contain an independent, self-contained municipal problem report to qualify. If its meaning depends on or replies to the non-civic parent, exclude it as ${parentReason === 'ADVERTISEMENT_OR_SPAM' ? 'ADVERTISEMENT_OR_SPAM' : 'GENERAL_CHATTER'}.`);
    } else if (input.replyMetadata) {
      if (input.replyMetadata.replyToIsForwarded) {
        sections.push(`### REPLY CONTEXT
- Note: This message is a reply to a Telegram-forwarded parent message.
- Isolation Rule: The parent message is excluded and not provided. The candidate message MUST contain a self-contained civic signal to qualify. If its meaning depends on the missing forwarded parent, exclude it as UNRESOLVED_AMBIGUOUS_FRAGMENT.`);
      } else {
        sections.push(`### REPLY CONTEXT
- Reply To Message ID: ${input.replyMetadata.replyToMessageId}`);
      }
    }

    // Extract Immediate Preceding Message or Chat Continuity
    const continuity = input.chatContinuity;
    let precedingMsg: PrecedingMessageContext | null =
      continuity?.precedingRelevantMessage ?? input.immediatePrecedingMessage ?? null;

    if (!precedingMsg && !continuity && input.snapshot.evidence.length > 0) {
      const candidateTime = new Date(input.originalTimestamp).getTime();
      const earlierItems = input.snapshot.evidence.filter(
        (e) => new Date(e.originalTimestamp).getTime() <= candidateTime,
      );
      const nearestEarlier = earlierItems[earlierItems.length - 1];

      if (nearestEarlier) {
        precedingMsg = {
          telegramMessageId: nearestEarlier.telegramMessageId,
          telegramUserId: nearestEarlier.telegramUserId ?? null,
          originalTimestamp: nearestEarlier.originalTimestamp,
          verbatimText: nearestEarlier.verbatimText,
          lane: nearestEarlier.lane ?? null,
        };
      }
    }

    if (continuity && continuity.interveningCount > 0 && precedingMsg) {
      const candidateTime = new Date(input.originalTimestamp).getTime();
      const prevTime = new Date(precedingMsg.originalTimestamp).getTime();
      const diffMinutes =
        !Number.isNaN(prevTime) && !Number.isNaN(candidateTime)
          ? Math.round((candidateTime - prevTime) / 60000)
          : null;
      const diffText = diffMinutes !== null ? ` (+${diffMinutes}m before candidate)` : '';
      const laneText = precedingMsg.lane ? ` (Lane: [${precedingMsg.lane}])` : '';
      const replyTargetText = input.replyMetadata?.replyToMessageId
        ? `MsgID ${input.replyMetadata.replyToMessageId}`
        : 'None (posted openly in chat)';

      const isSameSender =
        Boolean(input.telegramUserId && precedingMsg.telegramUserId && input.telegramUserId === precedingMsg.telegramUserId) ||
        Boolean(input.authorPriorEvidence && input.authorPriorEvidence.some((e) => e.telegramMessageId === precedingMsg?.telegramMessageId));

      const senderRelationText = isSameSender
        ? "SAME SENDER AS CANDIDATE (Author Continuity applies - see AUTHOR'S PRIOR SAME-DAY CIVIC CONTEXT)"
        : 'DIFFERENT SENDER (Third-party message - strict anti-latching applies)';

      sections.push(`### CHAT CONTINUITY STATUS (INTERRUPTED THREAD)
- Earlier Civic Evidence: MsgID ${precedingMsg.telegramMessageId}${diffText}${laneText}
- Sender of Earlier Evidence: ${senderRelationText}
- Intervening Unrelated Messages: ${continuity.interveningCount} message(s) occurred in chat between earlier civic evidence and candidate
- Conversational Continuity: BROKEN (Thread interrupted by unrelated chat)
- Explicit Reply Target: ${replyTargetText}
- RULE: Candidate must be fully self-contained UNLESS sent by the same resident continuing their earlier civic grievance. Vague fragments from third parties without municipal keywords MUST be excluded as UNRESOLVED_AMBIGUOUS_FRAGMENT.`);
    } else if (precedingMsg) {
      const candidateTime = new Date(input.originalTimestamp).getTime();
      const prevTime = new Date(precedingMsg.originalTimestamp).getTime();
      const diffMinutes =
        !Number.isNaN(prevTime) && !Number.isNaN(candidateTime)
          ? Math.round((candidateTime - prevTime) / 60000)
          : null;
      const diffText = diffMinutes !== null ? ` (+${diffMinutes}m before candidate)` : '';
      const laneText = precedingMsg.lane ? ` (Lane: [${precedingMsg.lane}])` : '';
      sections.push(`### IMMEDIATE PRECEDING MESSAGE (N-1 IN CHAT)
- Message ID: ${precedingMsg.telegramMessageId}${diffText}${laneText}
- Timestamp: ${precedingMsg.originalTimestamp}
- Text: "${precedingMsg.verbatimText}"`);
    }

    sections.push(formatSnapshotForSemanticRelevance(input.snapshot));

    if (input.vocabularyGuidance && input.vocabularyGuidance.length > 0) {
      sections.push(`### CONFIGURED DISTRICT RECOGNITION VOCABULARY (GUIDANCE ONLY)
[${input.vocabularyGuidance.join(', ')}]`);
    }

    sections.push(`Analyze the candidate message above and return the semantic relevance decision.`);
    return sections.join('\n\n');
  }

  public async evaluateRelevance(
    input: EvaluateRelevanceInput,
  ): Promise<AiGatewayResult<SemanticRelevanceResult>> {
    const userPrompt = this.buildUserPrompt(input);

    return this.aiGateway.generateStructured<SemanticRelevanceResult>({
      operationType: 'SEMANTIC_RELEVANCE',
      profileId: input.profileId,
      systemPrompt: SEMANTIC_RELEVANCE_SYSTEM_PROMPT,
      userPrompt,
      schema: SemanticRelevanceResultSchema,
      schemaName: 'semantic_relevance_result',
    });
  }
}
