import React, { useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Button, Typography, Space } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { HelpContent } from '../components/topics/HelpContent.js';

const { Title } = Typography;

export const DashboardHelpPage: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const headingRef = useRef<HTMLDivElement>(null);

  // Programmatic focus on page heading upon mount (AC 4)
  useEffect(() => {
    const timer = setTimeout(() => {
      headingRef.current?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, []);

  const handleBack = () => {
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate({ pathname: '/', search: location.search });
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: '#F4F6F8',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Top Sticky Navigation Bar */}
      <header
        style={{
          backgroundColor: '#FFFFFF',
          borderBottom: '1px solid #E2E8F0',
          padding: '12px 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          position: 'sticky',
          top: 0,
          zIndex: 20,
          boxShadow: 'none',
        }}
      >
        <Space size={12}>
          <Button
            type="text"
            icon={<ArrowLeftOutlined />}
            onClick={handleBack}
            aria-label="Бош саҳифага қайтиш"
            style={{
              fontWeight: 600,
              fontSize: 14,
              color: '#0F172A',
              minHeight: 44,
              minWidth: 44,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            Орқага
          </Button>

          <div
            ref={headingRef}
            tabIndex={-1}
            id="dashboard-help-page-heading"
            style={{ outline: 'none' }}
          >
            <Title
              level={4}
              style={{
                margin: 0,
                fontSize: 16,
                fontWeight: 700,
                color: '#0F172A',
              }}
            >
              Тизим ёрдами
            </Title>
          </div>
        </Space>
      </header>

      {/* Main Content Area */}
      <main
        style={{
          flex: 1,
          maxWidth: 720,
          width: '100%',
          margin: '0 auto',
          padding: '20px 16px 40px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <HelpContent />
      </main>
    </div>
  );
};
