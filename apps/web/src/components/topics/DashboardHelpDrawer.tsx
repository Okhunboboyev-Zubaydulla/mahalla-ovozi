import React, { useEffect, useRef } from 'react';
import { Drawer, Typography } from 'antd';
import { CloseOutlined, QuestionCircleOutlined } from '@ant-design/icons';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion.js';
import { HelpContent } from './HelpContent.js';

const { Title } = Typography;

export interface DashboardHelpDrawerProps {
  open: boolean;
  onClose: () => void;
}

export const DashboardHelpDrawer: React.FC<DashboardHelpDrawerProps> = ({
  open,
  onClose,
}) => {
  const headingRef = useRef<HTMLDivElement>(null);
  const prefersReducedMotion = usePrefersReducedMotion();

  // Programmatic focus on drawer heading when opened (AC 3)
  useEffect(() => {
    if (!open) {
      return;
    }
    const timer = setTimeout(() => {
      headingRef.current?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, [open]);

  // Keyboard Escape listener to close drawer and restore focus (AC 3)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  const noMotion = { motionAppear: false, motionEnter: false, motionLeave: false };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      mask={true}
      style={{ maxWidth: '100vw' }}
      width={typeof window !== 'undefined' ? Math.min(540, window.innerWidth - 32) : 540}
      motion={prefersReducedMotion ? noMotion : undefined}
      maskMotion={prefersReducedMotion ? noMotion : undefined}
      aria-label="Тизим ёрдами ва тушунтиришлар"
      aria-modal={true}
      keyboard={true}
      closeIcon={<CloseOutlined aria-label="Ёпиш" style={{ fontSize: 16, color: '#64748B' }} />}
      styles={{
        mask: {
          backgroundColor: 'rgba(15, 23, 42, 0.25)',
          backdropFilter: 'blur(2px)',
        },
        wrapper: {
          top: 16,
          right: 16,
          bottom: 16,
          height: 'calc(100vh - 32px)',
          maxHeight: 'calc(100vh - 32px)',
          borderRadius: 16,
          overflow: 'hidden',
          boxShadow: '0 20px 25px -5px rgba(15, 23, 42, 0.14), 0 8px 10px -6px rgba(15, 23, 42, 0.08)',
        },
        content: {
          borderRadius: 16,
          overflow: 'hidden',
          border: '1px solid #E2E8F0',
          backgroundColor: '#FFFFFF',
          boxShadow: 'none',
        },
        header: {
          borderBottom: '1px solid #E2E8F0',
          padding: '14px 20px',
          backgroundColor: '#FFFFFF',
        },
        body: {
          padding: '20px',
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          overflowY: 'auto',
          backgroundColor: '#F8FAFC',
          scrollbarWidth: 'thin',
          scrollbarColor: '#CBD5E1 transparent',
        },
      }}
      title={
        <div
          ref={headingRef}
          tabIndex={-1}
          id="dashboard-help-heading"
          style={{ outline: 'none', display: 'flex', alignItems: 'center', gap: 10 }}
        >
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              backgroundColor: '#E0F2FE',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <QuestionCircleOutlined style={{ color: '#0284C7', fontSize: 16 }} />
          </div>
          <Title
            level={5}
            style={{
              margin: 0,
              fontSize: 16,
              fontWeight: 700,
              color: '#0F172A',
            }}
          >
            Тизим ёрдами ва тушунтиришлар
          </Title>
        </div>
      }
    >
      <section
        role="region"
        aria-label="Тизим ёрдами ва тушунтиришлар"
        style={{ display: 'flex', flexDirection: 'column' }}
      >
        <HelpContent />
      </section>
    </Drawer>
  );
};
