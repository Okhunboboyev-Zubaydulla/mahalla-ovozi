import React, { useState, useEffect, useRef } from 'react';
import {
  Card,
  Form,
  Button,
  Space,
  Badge,
  Alert,
  Typography,
  theme,
  App,
  Tag,
} from 'antd';
import {
  SaveOutlined,
  UndoOutlined,
  ExclamationCircleOutlined,
  DisconnectOutlined,
  BulbOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import {
  type DistrictAnalysisSettingsDto,
  type DistrictAnalysisSettingsDraftDto,
  type SaveDistrictAnalysisSettingsDraftRequest,
  SaveDistrictAnalysisSettingsDraftSchema,
} from '@mahalla-ovozi/api-contracts';
import {
  useSaveDistrictSettingsDraft,
  useActivateDistrictSettings,
} from '../../hooks/useDistrictAnalysisSettings.js';
import { useOnlineStatus } from '../../hooks/useOnlineStatus.js';
import { useDirtyState } from '../../district/useDirtyState.js';
import { HokimRecognitionTermsInput } from './HokimRecognitionTermsInput.js';
import { DistrictLocalVocabularyInput } from './DistrictLocalVocabularyInput.js';
import { AnalysisSettingsActivationModal } from './AnalysisSettingsActivationModal.js';
import { ApiError } from '../../lib/api-client.js';

const { Text, Title } = Typography;

interface DistrictSettingsDraftFormProps {
  districtId: string;
  districtName: string;
  activeSettings: DistrictAnalysisSettingsDto;
  draft: DistrictAnalysisSettingsDraftDto | null;
  onSaveSuccess?: () => void;
}

export const DistrictSettingsDraftForm: React.FC<
  DistrictSettingsDraftFormProps
> = ({ districtId, districtName, activeSettings, draft, onSaveSuccess }) => {
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const isOffline = useOnlineStatus();
  const [form] = Form.useForm<SaveDistrictAnalysisSettingsDraftRequest>();
  const errorSummaryRef = useRef<HTMLDivElement>(null);

  const saveMutation = useSaveDistrictSettingsDraft(districtId);
  const activateMutation = useActivateDistrictSettings(districtId);
  const [isActivationModalOpen, setIsActivationModalOpen] = useState(false);

  // Initial values baseline: draft if present, else activeSettings
  const initialValues: SaveDistrictAnalysisSettingsDraftRequest = {
    hokimRecognitionTerms:
      draft?.hokimRecognitionTerms || activeSettings.hokimRecognitionTerms,
    localVocabularyAdditions:
      draft?.localVocabularyAdditions || activeSettings.localVocabularyAdditions,
  };

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [isFormDirty, setIsFormDirty] = useState(false);

  // Sync form when incoming draft or activeSettings change (and form is not dirty)
  useEffect(() => {
    if (!isFormDirty) {
      form.setFieldsValue(initialValues);
      setFieldErrors({});
    }
  }, [draft?.updatedAt, activeSettings.id, districtId]);

  // Track dirty state with global unsaved guard
  useDirtyState('district-settings-draft', isFormDirty);

  const handleValuesChange = (
    changed: Partial<SaveDistrictAnalysisSettingsDraftRequest>,
  ) => {
    setIsFormDirty(true);
    // Clear specific error on change
    const changedKey = Object.keys(changed)[0];
    if (changedKey && fieldErrors[changedKey]) {
      setFieldErrors((prev) => {
        const next = { ...prev };
        delete next[changedKey];
        return next;
      });
    }
  };

  const handleResetToBaseline = () => {
    form.setFieldsValue(initialValues);
    setFieldErrors({});
    setIsFormDirty(false);
    message.info('Форма дастлабки ҳолатига қайтарилди.');
  };

  const handleSubmit = async () => {
    if (isOffline || saveMutation.isPending) return;

    const values =
      form.getFieldsValue(true) as SaveDistrictAnalysisSettingsDraftRequest;

    const parsed = SaveDistrictAnalysisSettingsDraftSchema.safeParse(values);
    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const pathKey = issue.path[0] ? String(issue.path[0]) : 'form';
        if (!errors[pathKey]) {
          errors[pathKey] = issue.message;
        }
      }
      setFieldErrors(errors);
      setTimeout(() => {
        errorSummaryRef.current?.focus();
      }, 0);
      return;
    }

    setFieldErrors({});

    try {
      const response = await saveMutation.mutateAsync(parsed.data);
      message.success(response.message || 'Қоралама муваффақиятли сақланди');
      setIsFormDirty(false);
      onSaveSuccess?.();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setFieldErrors({ server: err.message });
      } else if (err instanceof Error) {
        setFieldErrors({ server: err.message });
      } else {
        setFieldErrors({
          server: 'Қораламани сақлашда кутилмаган хатолик юз берди.',
        });
      }
      setTimeout(() => {
        errorSummaryRef.current?.focus();
      }, 0);
    }
  };

  const errorCount = Object.keys(fieldErrors).length;

  const getFieldError = (fieldName: string) => fieldErrors[fieldName];

  const fieldLabels: Record<string, string> = {
    hokimRecognitionTerms: 'Ҳокимга оид атамалар',
    localVocabularyAdditions: 'Қўшимча маҳаллий луғат',
    server: 'Сервер хатолиги',
  };

  return (
    <Card
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Title level={4} style={{ margin: 0 }}>
            {districtName}: Таҳлил созламалари қораламаси
          </Title>
          <Badge
            count="Қоралама"
            style={{
              backgroundColor: token.colorWarning,
              color: '#fff',
              fontWeight: 500,
            }}
          />
          {isFormDirty && (
            <Tag color="orange" style={{ margin: 0 }}>
              Ўзгаришлар сақланмаган
            </Tag>
          )}
        </div>
      }
      variant="outlined"
      style={{
        borderRadius: token.borderRadiusLG,
        background: token.colorBgContainer,
      }}
    >
      {/* AI Guidance Context Notice (AC 6) */}
      <Alert
        message="АИ учун контекст йўриқномаси"
        description="Ушбу атамалар сунъий интеллект моделига туман раҳбарияти ва маҳаллий жойларни аниқроқ танишда кўмаклашувчи контекст сифатида хизмат қилади. Атамалар қатъий фильтр эмас, балки модель учун контекстуал йўриқномадир."
        type="info"
        showIcon
        icon={<BulbOutlined />}
        style={{ marginBottom: 20, borderRadius: token.borderRadius }}
      />

      {/* Offline Status Banner (AC 10) */}
      {isOffline && (
        <Alert
          message="Тармоқ билан алоқа узилган"
          description="Сиз офлайн режимдасиз. Маълумотларни кўриб чиқишингиз мумкин, бироқ қораламани сақлаш учун интернет алоқаси талаб этилади."
          type="warning"
          showIcon
          icon={<DisconnectOutlined />}
          style={{ marginBottom: 16 }}
        />
      )}

      {/* Accessible Error Summary Container (AC 7, 11) */}
      {errorCount > 0 && (
        <div
          ref={errorSummaryRef}
          tabIndex={-1}
          id="district-settings-error-summary"
          role="alert"
          style={{
            background: token.colorErrorBg,
            border: `1px solid ${token.colorErrorBorder}`,
            borderRadius: token.borderRadius,
            padding: 16,
            marginBottom: 24,
            outline: 'none',
          }}
        >
          <div
            style={{
              fontWeight: 600,
              color: token.colorErrorText,
              marginBottom: 8,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <ExclamationCircleOutlined />
            <span>Тўлдиришда хатоликлар мавжуд ({errorCount} та):</span>
          </div>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {Object.entries(fieldErrors).map(([field, msg]) => (
              <li key={field}>
                {field !== 'server' ? (
                  <button
                    type="button"
                    onClick={() => {
                      form.scrollToField(field, {
                        behavior: 'smooth',
                        focus: true,
                      });
                      const targetInputId =
                        field === 'hokimRecognitionTerms'
                          ? 'hokim-new-term'
                          : field === 'localVocabularyAdditions'
                            ? 'district-vocab-new-term'
                            : `draft-${field}`;
                      const el =
                        document.getElementById(targetInputId) ||
                        document.getElementById(`draft-${field}`);
                      if (el) el.focus();
                    }}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      color: token.colorPrimary,
                      textDecoration: 'underline',
                      cursor: 'pointer',
                      fontSize: 14,
                    }}
                  >
                    {fieldLabels[field] || field}: {msg}
                  </button>
                ) : (
                  <Text type="danger" style={{ fontSize: 14 }}>
                    {msg}
                  </Text>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Form
        form={form}
        layout="vertical"
        initialValues={initialValues}
        onValuesChange={handleValuesChange}
        requiredMark="optional"
      >
        <Form.Item
          name="hokimRecognitionTerms"
          label={
            <Text strong>
              Ҳокимга оид атамалар (Hokim Recognition Terms)
            </Text>
          }
          extra="Ҳоким, ҳокимият ва сектор раҳбарларига ишора қилувчи атама ва лақаблар рўйхати."
          required
          validateStatus={
            getFieldError('hokimRecognitionTerms') ? 'error' : undefined
          }
          help={getFieldError('hokimRecognitionTerms')}
        >
          <HokimRecognitionTermsInput />
        </Form.Item>

        <Form.Item
          name="localVocabularyAdditions"
          label={
            <Text strong>
              Қўшимча маҳаллий луғат (District Local Vocabulary Additions)
            </Text>
          }
          extra="Тумандаги маҳаллалар, маҳаллий жойлар, сув ҳавзалари ва муассасалар номлари (ихтиёрий)."
          validateStatus={
            getFieldError('localVocabularyAdditions') ? 'error' : undefined
          }
          help={getFieldError('localVocabularyAdditions')}
        >
          <DistrictLocalVocabularyInput />
        </Form.Item>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            borderTop: `1px solid ${token.colorBorderSecondary}`,
            paddingTop: 16,
            marginTop: 16,
          }}
        >
          <Button
            icon={<UndoOutlined />}
            onClick={handleResetToBaseline}
            disabled={!isFormDirty || saveMutation.isPending}
          >
            Ўзгаришларни бекор қилиш
          </Button>

          <Space>
            <Button
              id="district-review-activation-button"
              icon={<ThunderboltOutlined />}
              onClick={() => setIsActivationModalOpen(true)}
              disabled={isOffline || saveMutation.isPending || activateMutation.isPending}
            >
              Фаоллаштиришни кўриб чиқиш
            </Button>
            <Button
              id="district-draft-submit-button"
              type="primary"
              icon={<SaveOutlined />}
              onClick={handleSubmit}
              loading={saveMutation.isPending}
              disabled={isOffline}
            >
              Сақлаш
            </Button>
          </Space>
        </div>
      </Form>

      <AnalysisSettingsActivationModal
        open={isActivationModalOpen}
        districtId={districtId}
        districtName={districtName}
        activeVersionId={activeSettings.id}
        activeSettings={activeSettings}
        draftSettings={{ ...initialValues, ...form.getFieldsValue(true) }}
        onConfirm={async (changeReason) => {
          if (isFormDirty) {
            const values =
              form.getFieldsValue(true) as SaveDistrictAnalysisSettingsDraftRequest;
            const parsed =
              SaveDistrictAnalysisSettingsDraftSchema.safeParse(values);
            if (!parsed.success) {
              const firstError =
                parsed.error.issues[0]?.message ||
                'Қораламада хатоликлар мавжуд. Илтимос, формани тўғри тўлдиринг.';
              throw new Error(firstError);
            }
            await saveMutation.mutateAsync(parsed.data);
          }
          const res = await activateMutation.mutateAsync({
            baseActiveVersionId: activeSettings.id,
            changeReason,
          });
          message.success(
            res.message ||
              `${districtName}: Таҳлил созламалари муваффақиятли фаоллаштирилди.`,
          );
          setIsActivationModalOpen(false);
          setIsFormDirty(false);
          onSaveSuccess?.();
        }}
        onCancel={() => setIsActivationModalOpen(false)}
        onRefresh={() => {
          setIsActivationModalOpen(false);
          onSaveSuccess?.();
        }}
      />
    </Card>
  );
};
