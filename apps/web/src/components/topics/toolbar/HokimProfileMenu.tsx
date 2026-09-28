import React, { useState, useRef } from 'react';
import { Button, Typography, Popover, Tag, Divider, Drawer } from 'antd';
import {
  LogoutOutlined,
  EnvironmentOutlined,
  UserOutlined,
  CloseOutlined,
} from '@ant-design/icons';
import { useAuth } from '../../../auth/auth-context.js';

const { Text, Title } = Typography;

export interface HokimProfileMenuProps {
  districtName: string;
  isMobile: boolean;
  isPhone: boolean;
}

export const HokimProfileMenu: React.FC<HokimProfileMenuProps> = ({
  districtName,
  isMobile,
  isPhone,
}) => {
  const { actor, signOut, isSigningOut } = useAuth();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [mobileProfileOpen, setMobileProfileOpen] = useState(false);
  const profileButtonRef = useRef<HTMLButtonElement | null>(null);

  if (isMobile) {
    return (
      <>
        <Button
          id="dashboard-profile-button"
          ref={profileButtonRef}
          type={isPhone ? 'default' : 'text'}
          icon={<UserOutlined style={{ color: '#0284C7', fontSize: 15 }} />}
          onClick={() => setMobileProfileOpen(true)}
          aria-label="Ҳоким профили ва сессия созламалари"
          aria-haspopup="dialog"
          aria-expanded={mobileProfileOpen}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            fontSize: 14,
            fontWeight: 500,
            color: '#0F172A',
            boxShadow: 'none',
            height: 32,
            width: isPhone ? 32 : 'auto',
            padding: isPhone ? 0 : '0 8px',
            borderRadius: 6,
            borderColor: isPhone ? '#CBD5E1' : undefined,
            backgroundColor: isPhone ? '#FFFFFF' : undefined,
          }}
        >
          {!isPhone ? (actor?.username || 'Ҳоким') : null}
        </Button>

        <Drawer
          placement="bottom"
          height="auto"
          open={mobileProfileOpen}
          onClose={() => {
            setMobileProfileOpen(false);
            profileButtonRef.current?.focus();
          }}
          mask={true}
          maskClosable={true}
          closable={false}
          destroyOnHidden={true}
          aria-label="Ҳоким профили"
          aria-modal={true}
          styles={{
            wrapper: {
              borderTopLeftRadius: 16,
              borderTopRightRadius: 16,
              overflow: 'hidden',
            },
            content: {
              borderTopLeftRadius: 16,
              borderTopRightRadius: 16,
              backgroundColor: '#FFFFFF',
            },
            body: {
              padding: '16px 20px 24px 20px',
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
            },
          }}
        >
          {/* Drag Handle Indicator */}
          <div
            aria-hidden="true"
            style={{
              width: 36,
              height: 4,
              borderRadius: 2,
              backgroundColor: '#CBD5E1',
              margin: '0 auto 6px auto',
            }}
          />

          {/* Header row with Title and Close Button */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Title level={5} style={{ margin: 0, color: '#0F172A', fontSize: 16, fontWeight: 700 }}>
              Ҳоким профили
            </Title>
            <Button
              type="text"
              icon={<CloseOutlined style={{ fontSize: 15, color: '#64748B' }} />}
              onClick={() => {
                setMobileProfileOpen(false);
                profileButtonRef.current?.focus();
              }}
              aria-label="Ёпиш"
              style={{
                width: 32,
                height: 32,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0,
              }}
            />
          </div>

          {/* User details card */}
          <div
            style={{
              backgroundColor: '#F8FAFC',
              border: '1px solid #E2E8F0',
              borderRadius: 10,
              padding: '12px 14px',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text strong style={{ fontSize: 16, color: '#0F172A' }}>
                {actor?.username || 'Ҳоким'}
              </Text>
              <Tag
                color="cyan"
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  padding: '2px 8px',
                  borderRadius: 4,
                  margin: 0,
                }}
              >
                Туман ҳокими
              </Tag>
            </div>

            <Text
              type="secondary"
              style={{
                fontSize: 13,
                color: '#64748B',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <EnvironmentOutlined style={{ color: '#0284C7' }} />
              {districtName}
            </Text>
          </div>

          {/* 44px-tall Touch-Friendly Sign Out Button */}
          <Button
            type="primary"
            danger
            icon={<LogoutOutlined />}
            loading={isSigningOut}
            onClick={() => {
              setMobileProfileOpen(false);
              signOut();
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              fontSize: 15,
              fontWeight: 600,
              color: '#FFFFFF',
              backgroundColor: '#EF4444',
              borderColor: '#EF4444',
              height: 44,
              width: '100%',
              borderRadius: 8,
              boxShadow: 'none',
              marginTop: 4,
            }}
            aria-label="Тизимдан чиқиш"
          >
            Чиқиш
          </Button>
        </Drawer>
      </>
    );
  }

  return (
    <Popover
      content={
        <div
          role="dialog"
          aria-label="Ҳоким профили"
          style={{
            minWidth: 220,
            padding: '4px 0',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div>
            <Text strong style={{ fontSize: 15, color: '#0F172A', display: 'block' }}>
              {actor?.username || 'Ҳоким'}
            </Text>
            <Text
              type="secondary"
              style={{
                fontSize: 13,
                color: '#64748B',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                marginTop: 2,
              }}
            >
              <EnvironmentOutlined style={{ color: '#0284C7' }} />
              {districtName}
            </Text>
          </div>

          <div>
            <Tag
              color="cyan"
              style={{
                fontSize: 12,
                fontWeight: 600,
                padding: '2px 8px',
                borderRadius: 4,
                margin: 0,
              }}
            >
              Туман ҳокими
            </Tag>
          </div>

          <Divider style={{ margin: '6px 0', borderColor: '#E2E8F0' }} />

          <Button
            type="text"
            danger
            icon={<LogoutOutlined />}
            loading={isSigningOut}
            onClick={() => {
              setPopoverOpen(false);
              signOut();
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 14,
              fontWeight: 500,
              color: '#EF4444',
              padding: '4px 8px',
              height: 36,
              width: '100%',
              justifyContent: 'flex-start',
              boxShadow: 'none',
              borderRadius: 6,
            }}
            aria-label="Тизимдан чиқиш"
          >
            Чиқиш
          </Button>
        </div>
      }
      trigger="click"
      open={popoverOpen}
      onOpenChange={(nextOpen) => {
        setPopoverOpen(nextOpen);
        if (!nextOpen) {
          profileButtonRef.current?.focus();
        }
      }}
      placement="bottomRight"
      autoAdjustOverflow={true}
      destroyOnHidden={true}
      styles={{
        body: {
          boxShadow: 'none',
          border: '1px solid #E2E8F0',
          backgroundColor: '#FFFFFF',
          borderRadius: 10,
          padding: '12px 16px',
        },
      }}
    >
      <Button
        id="dashboard-profile-button"
        ref={profileButtonRef}
        type="text"
        icon={<UserOutlined style={{ color: '#0284C7', fontSize: 15 }} />}
        aria-label="Ҳоким профили ва сессия созламалари"
        aria-haspopup="dialog"
        aria-expanded={popoverOpen}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          fontSize: 14,
          fontWeight: 500,
          color: '#0F172A',
          boxShadow: 'none',
          height: 32,
          width: 'auto',
          padding: '0 10px',
          borderRadius: 6,
          backgroundColor: '#F8FAFC',
          border: '1px solid #E2E8F0',
        }}
      >
        {actor?.username || 'Ҳоким'}
      </Button>
    </Popover>
  );
};
