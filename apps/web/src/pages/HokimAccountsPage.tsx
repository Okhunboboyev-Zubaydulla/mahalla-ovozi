import { useState, useCallback } from 'react';
import {
  Card,
  Typography,
  Alert,
  Spin,
  Empty,
} from 'antd';
import {
  WarningOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import { useDistrict } from '../district/district-context.js';
import { useHokimAccount } from '../district/useHokimAccount.js';
import { districtClient } from '../district/district-client.js';
import { districtQueryKeys } from '../district/query-keys.js';
import { useQuery } from '@tanstack/react-query';
import { OneTimeCredentialModal } from '../components/OneTimeCredentialModal.js';
import { CreateHokimModal } from '../components/CreateHokimModal.js';
import { ResetHokimModal } from '../components/ResetHokimModal.js';
import { ReplaceHokimModal } from '../components/ReplaceHokimModal.js';
import { EditHokimUsernameModal } from '../components/EditHokimUsernameModal.js';
import { DisableHokimModal } from '../components/DisableHokimModal.js';
import { HokimNoAccountCard } from '../components/HokimNoAccountCard.js';
import { HokimActiveAccountCard } from '../components/HokimActiveAccountCard.js';
import { HokimDisabledAccountCard } from '../components/HokimDisabledAccountCard.js';
import { useOnlineStatus } from '../hooks/useOnlineStatus.js';

const { Title, Text, Paragraph } = Typography;

export interface HokimAccountsPageProps {
  districtId?: string;
}

export function HokimAccountsPage({ districtId }: HokimAccountsPageProps) {
  const { activeDistrictId: contextDistrictId } = useDistrict();
  const effectiveDistrictId = districtId ?? contextDistrictId;

  const { data: districtResponse } = useQuery({
    queryKey: districtQueryKeys.district(effectiveDistrictId),
    queryFn: () => (effectiveDistrictId ? districtClient.getDistrict(effectiveDistrictId) : null),
    enabled: !!effectiveDistrictId,
  });
  const activeDistrict = districtResponse?.district ?? null;

  const {
    hokimState,
    account,
    isLoading,
    error,
    createHokimAccount,
    isCreating,
    createError,
    resetCreateError,
    resetPassword,
    isResetting,
    resetPasswordError,
    resetPasswordResetError,
    disableHokimAccount,
    isDisabling,
    disableError,
    resetDisableError,
    replaceHokimAccount,
    isReplacing,
    replaceError,
    resetReplaceError,
    updateHokimUsername,
    isUpdatingUsername,
    updateUsernameError,
    resetUpdateUsernameError,
  } = useHokimAccount(effectiveDistrictId);

  const isOffline = useOnlineStatus();

  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isResetModalOpen, setIsResetModalOpen] = useState(false);
  const [isReplaceModalOpen, setIsReplaceModalOpen] = useState(false);
  const [isDisableModalOpen, setIsDisableModalOpen] = useState(false);

  // Ephemeral one-time credential state (zero persistent storage)
  const [oneTimeCredential, setOneTimeCredential] = useState<{
    username: string;
    temporaryPassword: string;
    title: string;
  } | null>(null);

  const handleOpenCreate = useCallback(() => {
    resetCreateError();
    setIsCreateModalOpen(true);
  }, [resetCreateError]);

  const handleOpenEdit = useCallback(() => {
    resetUpdateUsernameError();
    setIsEditModalOpen(true);
  }, [resetUpdateUsernameError]);

  const handleOpenReset = useCallback(() => {
    resetPasswordResetError();
    setIsResetModalOpen(true);
  }, [resetPasswordResetError]);

  const handleOpenReplace = useCallback(() => {
    resetReplaceError();
    setIsReplaceModalOpen(true);
  }, [resetReplaceError]);

  const handleOpenDisable = useCallback(() => {
    resetDisableError();
    setIsDisableModalOpen(true);
  }, [resetDisableError]);

  const handleCloseCreate = useCallback(() => setIsCreateModalOpen(false), []);
  const handleCloseEdit = useCallback(() => setIsEditModalOpen(false), []);
  const handleCloseReset = useCallback(() => setIsResetModalOpen(false), []);
  const handleCloseReplace = useCallback(() => setIsReplaceModalOpen(false), []);
  const handleCloseDisable = useCallback(() => setIsDisableModalOpen(false), []);
  const handleCloseOneTime = useCallback(() => setOneTimeCredential(null), []);

  const handleCreateSubmit = useCallback(async (values: { username: string }) => {
    const res = await createHokimAccount(values);
    setIsCreateModalOpen(false);
    setOneTimeCredential({ username: res.account.username, temporaryPassword: res.temporaryPassword, title: 'Ҳоким аккаунти муваффақиятли яратилди' });
  }, [createHokimAccount]);

  const handleEditSubmit = useCallback(async (values: { username: string }) => {
    await updateHokimUsername(values);
    setIsEditModalOpen(false);
  }, [updateHokimUsername]);

  const handleResetConfirm = useCallback(async () => {
    const res = await resetPassword();
    setIsResetModalOpen(false);
    setOneTimeCredential({ username: res.account.username, temporaryPassword: res.temporaryPassword, title: 'Парол муваффақиятли янгиланди' });
  }, [resetPassword]);

  const handleReplaceSubmit = useCallback(async (values: { newUsername: string }) => {
    const res = await replaceHokimAccount(values);
    setIsReplaceModalOpen(false);
    setOneTimeCredential({ username: res.account.username, temporaryPassword: res.temporaryPassword, title: 'Ҳоким аккаунти муваффақиятли алмаштирилди' });
  }, [replaceHokimAccount]);

  const handleDisableConfirm = useCallback(async () => {
    await disableHokimAccount();
    setIsDisableModalOpen(false);
  }, [disableHokimAccount]);

  if (!effectiveDistrictId) {
    return (
      <Card variant="borderless" style={{ borderRadius: 12, padding: '24px 16px' }}>
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Text type="secondary" style={{ fontSize: 16 }}>
              Ҳоким аккаунтини бошқариш учун аввал юқоридаги менюдан туманни танланг.
            </Text>
          }
        />
      </Card>
    );
  }

  if (isLoading) {
    return (
      <Card variant="borderless" style={{ borderRadius: 12, textAlign: 'center', padding: 48 }}>
        <Spin size="large" />
        <Paragraph type="secondary" style={{ marginTop: 16 }}>
          Ҳоким аккаунти маълумотлари юкланмоқда...
        </Paragraph>
      </Card>
    );
  }

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto' }}>
      <div style={{ marginBottom: 24 }}>
        <Title level={3} style={{ marginBottom: 4 }}>
          Ҳоким аккаунтини бошқариш
        </Title>
        <Text type="secondary" style={{ fontSize: 14 }}>
          {activeDistrict?.name
            ? `Танланган туман: ${activeDistrict.name}`
            : 'Туман ҳокими учун хавфсиз кириш ҳисобини яратиш ва бошқариш'}
        </Text>
      </div>

      {isOffline && (
        <Alert
          message="Интерфейс автоном (офлайн) режимда"
          description="Интернет уланиши йўқ. Аккаунт яратиш, паролни янгилаш ёки алмаштириш амаллари интернет пайдо бўлгунча чекланади."
          type="warning"
          showIcon
          icon={<WarningOutlined />}
          style={{ marginBottom: 20 }}
        />
      )}

      {error && (
        <Alert
          message="Маълумотларни юклашда хатолик юз берди"
          description={error.message}
          type="error"
          showIcon
          style={{ marginBottom: 20 }}
        />
      )}

      {hokimState === 'NO_ACCOUNT' && (
        <HokimNoAccountCard isOffline={isOffline} onCreateClick={handleOpenCreate} />
      )}

      {hokimState === 'ACTIVE' && account && (
        <HokimActiveAccountCard
          account={account}
          isOffline={isOffline}
          onEditClick={handleOpenEdit}
          onResetClick={handleOpenReset}
          onReplaceClick={handleOpenReplace}
          onDisableClick={handleOpenDisable}
        />
      )}

      {hokimState === 'DISABLED' && account && (
        <HokimDisabledAccountCard
          account={account}
          isOffline={isOffline}
          onReplaceClick={handleOpenReplace}
          onCreateClick={handleOpenCreate}
        />
      )}

      <div style={{ marginTop: 24 }}>
        <Alert
          message="Хавфсизлик бўйича муҳим эслатма"
          description="Ҳар бир туман учун фақат битта фаол ҳоким аккаунти бириктирилиши мумкин. Ҳоким аккаунти тизимда туман маълумотлари билан ишлаш учун қатъий чегараланган ҳуқуқларга эга бўлади. Парол очиқ ҳолда тизимда сақланмайди ва фақат яратиш/янгилаш вақтида бир марта кўрсатилади."
          type="info"
          showIcon
          icon={<InfoCircleOutlined />}
        />
      </div>

      <CreateHokimModal
        isOpen={isCreateModalOpen}
        onClose={handleCloseCreate}
        onSubmit={handleCreateSubmit}
        isLoading={isCreating}
        error={createError}
      />
      <EditHokimUsernameModal
        isOpen={isEditModalOpen}
        onClose={handleCloseEdit}
        onSubmit={handleEditSubmit}
        currentUsername={account?.username ?? ''}
        isLoading={isUpdatingUsername}
        error={updateUsernameError}
      />
      <ResetHokimModal
        isOpen={isResetModalOpen}
        onClose={handleCloseReset}
        onConfirm={handleResetConfirm}
        username={account?.username ?? ''}
        isLoading={isResetting}
        error={resetPasswordError}
      />
      <ReplaceHokimModal
        isOpen={isReplaceModalOpen}
        onClose={handleCloseReplace}
        onSubmit={handleReplaceSubmit}
        currentUsername={account?.username ?? ''}
        isLoading={isReplacing}
        error={replaceError}
      />
      <DisableHokimModal
        isOpen={isDisableModalOpen}
        onClose={handleCloseDisable}
        onConfirm={handleDisableConfirm}
        username={account?.username ?? ''}
        isLoading={isDisabling}
        error={disableError}
      />
      <OneTimeCredentialModal
        isOpen={Boolean(oneTimeCredential)}
        onClose={handleCloseOneTime}
        username={oneTimeCredential?.username ?? ''}
        temporaryPassword={oneTimeCredential?.temporaryPassword ?? null}
        title={oneTimeCredential?.title}
      />
    </div>
  );
}

export default HokimAccountsPage;
