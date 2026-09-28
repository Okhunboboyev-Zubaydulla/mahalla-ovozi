import React, { useState, useEffect } from 'react';
import { Modal, Button, Typography, Alert, Space, List, App } from 'antd';
import { CheckCircleOutlined, ExclamationCircleOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useDistrictActivation } from '../district/useDistrictActivation.js';
import { useDistrict } from '../district/district-context.js';
import { ApiError } from '../lib/api-client.js';
import { PrerequisiteItem } from '@mahalla-ovozi/api-contracts';
import { useOnlineStatus } from '../hooks/useOnlineStatus.js';

const { Paragraph, Text } = Typography;

interface DistrictActivationModalProps {
  open: boolean;
  onClose: () => void;
  districtId: string;
  districtName?: string;
  onSuccess?: () => void;
}

export const DistrictActivationModal: React.FC<DistrictActivationModalProps> = ({
  open,
  onClose,
  districtId,
  districtName,
  onSuccess,
}) => {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const { activateDistrict, isActivating, reset } = useDistrictActivation(districtId);

  const { clearDirty } = useDistrict();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorBlockers, setErrorBlockers] = useState<PrerequisiteItem[] | null>(null);
  const isOffline = useOnlineStatus();

  useEffect(() => {
    if (open) {
      setErrorMessage(null);
      setErrorBlockers(null);
      reset();
    }
  }, [open, reset]);

  const handleClose = () => {
    if (isActivating) return;
    clearDirty('district-activation-modal');
    setErrorMessage(null);
    setErrorBlockers(null);
    reset();
    onClose();
  };

  const handleActivate = async () => {
    if (isOffline) {
      setErrorMessage('Сервер билан алоқа мавжуд эмас. Тармоқни текширинг.');
      setErrorBlockers(null);
      return;
    }
    if (isActivating) return;

    setErrorMessage(null);
    setErrorBlockers(null);

    try {
      await activateDistrict();
      clearDirty('district-activation-modal');
      message.success('Туман муваффақиятли фаоллаштирилди!');
      if (onSuccess) {
        onSuccess();
      }
      onClose();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
        if (err.blockers && err.blockers.length > 0) {
          setErrorBlockers(err.blockers);
        }
      } else {
        setErrorMessage('Туманни фаоллаштиришда хатолик юз берди. Илтимос, қайта уриниб кўринг.');
      }
    }
  };

  return (
    <Modal
      title="Туманни фаоллаштиришни тасдиқлаш"
      open={open}
      onCancel={handleClose}
      destroyOnHidden
      centered
      closable={!isActivating}
      maskClosable={!isActivating}
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
          <Button
            id="activate-district-cancel"
            onClick={handleClose}
            disabled={isActivating}
            style={{ minHeight: 44 }}
          >
            Бекор қилиш
          </Button>
          <Button
            id="activate-district-submit"
            type="primary"
            onClick={handleActivate}
            loading={isActivating}
            disabled={isActivating || isOffline}
            style={{ minHeight: 44 }}
          >
            Фаоллаштиришни тасдиқлаш
          </Button>
        </div>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: '100%', padding: '12px 0' }}>
        {isOffline && (
          <Alert
            type="warning"
            showIcon
            message="Сервер билан алоқа мавжуд эмас. Тармоқни текширинг."
          />
        )}

        {errorMessage && !isOffline && (
          <Alert
            type="error"
            showIcon
            message="Фаоллаштиришда хатолик"
            description={
              <div>
                <div>{errorMessage}</div>
                {errorBlockers && errorBlockers.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <Text strong style={{ fontSize: 13 }}>
                      Қуйидаги талаблар тўлиқ бажарилмаган:
                    </Text>
                    <List
                      size="small"
                      dataSource={errorBlockers}
                      style={{ marginTop: 8 }}
                      renderItem={(blocker) => (
                        <List.Item
                          key={blocker.key}
                          extra={
                            blocker.actionPath ? (
                              <Button
                                size="small"
                                type="link"
                                onClick={() => {
                                  handleClose();
                                  navigate(blocker.actionPath!);
                                }}
                              >
                                Созлаш
                              </Button>
                            ) : null
                          }
                        >
                          <List.Item.Meta
                            title={blocker.label}
                            description={blocker.blockerReason || blocker.description}
                          />
                        </List.Item>
                      )}
                    />
                  </div>
                )}
              </div>
            }
          />
        )}

        <Paragraph>
          {districtName ? (
            <>
              <strong>{districtName}</strong> туманини тизимда расман фаоллаштиришни
              тасдиқлайсизми?
            </>
          ) : (
            'Мазкур туманни тизимда расман фаоллаштиришни тасдиқлайсизми?'
          )}
        </Paragraph>

        <Alert
          type="success"
          showIcon
          icon={<CheckCircleOutlined />}
          message="Тайёрлик талаблари текширилди"
          description="Барча 8 та дастлабки талаблар муваффақиятли бажарилди ва тизим хавфсизлик талабларига мос келади."
        />

        <Alert
          type="warning"
          showIcon
          icon={<ExclamationCircleOutlined />}
          message="Муҳим огоҳлантириш"
          description="Туман фаоллаштирилгандан сўнг, туман ҳокими тизимга кириш имкониятига эга бўлади ва маълумотлар йиғиш жараёни бошланади. Фаоллаштирилган туманни қайта созлаш ҳолатига қайтариб бўлмайди."
        />

        <Text type="secondary" style={{ fontSize: 13 }}>
          Фаоллаштиришни якунлаш учун «Фаоллаштиришни тасдиқлаш» тугмасини босинг.
        </Text>
      </Space>
    </Modal>
  );
};
