import React from 'react';
import { Typography, Tag, Button } from 'antd';
import {
  ClockCircleOutlined,
  UserOutlined,
  SendOutlined,
  PictureOutlined,
  BankOutlined,
} from '@ant-design/icons';
import { TopicEvidenceItem } from '@mahalla-ovozi/api-contracts';

const { Text, Paragraph } = Typography;

export interface EvidenceItemProps {
  evidence: TopicEvidenceItem;
  isTargetedPulse?: boolean;
}

export const EvidenceItem: React.FC<EvidenceItemProps> = ({ evidence, isTargetedPulse = false }) => {
  const senderDisplay = evidence.authorUsername || evidence.authorName || 'Фуқаро';

  const rawName = (evidence.authorName || evidence.authorUsername || '').replace(/^@/, '').trim();
  const avatarInitial = rawName ? rawName.charAt(0).toUpperCase() : null;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: 10,
        marginBottom: 14,
        width: '100%',
      }}
    >
      {/* 1. Citizen Avatar Chip */}
      <div
        aria-hidden="true"
        style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          backgroundColor: '#F1F5F9',
          color: '#475569',
          border: '1px solid #E2E8F0',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 13,
          fontWeight: 700,
          flexShrink: 0,
          marginBottom: 1,
        }}
      >
        {avatarInitial || <UserOutlined style={{ fontSize: 13 }} />}
      </div>

      {/* 2. Speech Bubble Container */}
      {(() => {
        const isHokim = Boolean(evidence.isHokimRelated);
        const bubbleBg = isHokim ? '#FEF2F2' : '#FFFFFF';
        const bubbleBorder = isTargetedPulse
          ? '#DC2626'
          : isHokim
            ? '#FECACA'
            : '#E2E8F0';
        const bubbleShadow = isTargetedPulse
          ? '0 0 0 2px #DC2626, 0 2px 8px rgba(220, 38, 38, 0.2)'
          : isHokim
            ? '0 1px 3px 0 rgba(220, 38, 38, 0.08), 0 1px 2px -1px rgba(220, 38, 38, 0.04)'
            : '0 1px 3px 0 rgba(15, 23, 42, 0.07), 0 1px 2px -1px rgba(15, 23, 42, 0.04)';

        return (
          <article
            id={`evidence-item-${evidence.id}`}
            tabIndex={0}
            aria-label={`Далил: ${senderDisplay}, ${evidence.formattedTime}${isHokim ? ', Ҳокимга мурожаат' : ''}`}
            style={{
              position: 'relative',
              flex: 1,
              minWidth: 0,
              maxWidth: '100%',
              backgroundColor: bubbleBg,
              border: `1px solid ${bubbleBorder}`,
              borderRadius: '14px 14px 14px 2px',
              padding: '12px 14px',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              boxShadow: bubbleShadow,
              outline: 'none',
              boxSizing: 'border-box',
              transition: 'box-shadow 0.4s ease, border-color 0.4s ease, background-color 0.4s ease',
            }}
          >
            {/* Seamless speech bubble tail protruding to bottom-left */}
            <svg
              aria-hidden="true"
              style={{
                position: 'absolute',
                bottom: -1,
                left: -7,
                width: 8,
                height: 12,
                pointerEvents: 'none',
                overflow: 'visible',
              }}
              viewBox="0 0 8 12"
            >
              <path
                d="M8 0 C8 6 4 12 0 12 L8 12 Z"
                fill={bubbleBg}
                stroke={bubbleBorder}
                strokeWidth={1}
              />
              {/* Mask line to erase the inner border seam between card and tail */}
              <line
                x1="8"
                y1="0"
                x2="8"
                y2="11.5"
                stroke={bubbleBg}
                strokeWidth={2.5}
              />
            </svg>

            {/* Header: Sender attribution + Timestamp + In-situ Anchor badge + Hokim badge */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: 6,
                width: '100%',
              }}
            >
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  minWidth: 0,
                  maxWidth: '100%',
                  flexWrap: 'wrap',
                }}
              >
                <Text
                  strong
                  style={{
                    fontSize: 13,
                    color: '#0F172A',
                    overflowWrap: 'anywhere',
                    wordBreak: 'normal',
                  }}
                >
                  {senderDisplay}
                </Text>
                {isHokim && (
                  <Tag
                    style={{
                      backgroundColor: '#FEE2E2',
                      color: '#DC2626',
                      borderColor: '#FECACA',
                      fontWeight: 600,
                      fontSize: 11,
                      borderRadius: 4,
                      margin: 0,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 3,
                      flexShrink: 0,
                      padding: '0 6px',
                    }}
                  >
                    <BankOutlined style={{ fontSize: 11 }} />
                    <span>Ҳокимга мурожаат</span>
                  </Tag>
                )}
                {evidence.contentType === 'MEDIA_CAPTION' && (
                  <Tag
                    icon={<PictureOutlined style={{ fontSize: 11 }} />}
                    style={{
                      fontSize: 11,
                      borderRadius: 4,
                      margin: 0,
                      backgroundColor: '#F1F5F9',
                      color: '#475569',
                      borderColor: '#CBD5E1',
                      flexShrink: 0,
                    }}
                  >
                    Медиа
                  </Tag>
                )}
              </div>

              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                {evidence.isAnchor && (
                  <Tag
                    style={{
                      backgroundColor: '#E0F2FE',
                      color: '#0284C7',
                      borderColor: '#BAE6FD',
                      fontWeight: 600,
                      fontSize: 12,
                      borderRadius: 4,
                      margin: 0,
                    }}
                  >
                    Дастлабки хабар
                  </Tag>
                )}
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#64748B', fontSize: 12 }}>
                  <ClockCircleOutlined style={{ fontSize: 12, color: '#94A3B8' }} />
                  <Text style={{ fontSize: 12, color: '#64748B' }}>{evidence.formattedTime}</Text>
                </span>
              </div>
            </div>

            {/* Body: Verbatim message text preserving line breaks */}
            <Paragraph
              style={{
                fontSize: 13.5,
                lineHeight: '20px',
                color: '#1E293B',
                margin: '2px 0 0 0',
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
                wordBreak: 'normal',
              }}
            >
              {evidence.verbatimText}
            </Paragraph>

            {/* Footer Action: Best-effort Telegram deep link button (AC 6) */}
            {evidence.telegramDeepLink && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4, width: '100%' }}>
                <Button
                  size="small"
                  type="default"
                  icon={<SendOutlined style={{ fontSize: 11 }} />}
                  href={evidence.telegramDeepLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    fontSize: 12,
                    borderRadius: 6,
                    borderColor: '#CBD5E1',
                    color: '#0284C7',
                    fontWeight: 500,
                    boxShadow: 'none',
                    height: 26,
                  }}
                >
                  Telegramда очиш
                </Button>
              </div>
            )}
          </article>
        );
      })()}
    </div>
  );
};
