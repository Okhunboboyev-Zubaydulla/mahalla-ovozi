import React from 'react';
import { Typography, Space } from 'antd';
import {
  InfoCircleOutlined,
  AppstoreOutlined,
  TagOutlined,
  HistoryOutlined,
  ClockCircleOutlined,
  LinkOutlined,
  SafetyCertificateOutlined,
  CalendarOutlined,
  StopOutlined,
} from '@ant-design/icons';

const { Title, Paragraph } = Typography;

export interface HelpSection {
  id: string;
  title: string;
  icon: React.ReactNode;
  content: string;
}

export const HELP_SECTIONS: HelpSection[] = [
  {
    id: 'signals-nature',
    title: 'Хабарлар ва далиллар табиати',
    icon: <InfoCircleOutlined style={{ color: '#0284C7' }} />,
    content:
      'Тахтадаги хабарлар фуқаролар томонидан Telegram гуруҳларида қолдирилган мурожаатлар бўлиб, расмий тасдиқланган далил, жамоатчиликнинг умумий фикри ёки якуний маъмурий хулоса ҳисобланмайди.',
  },
  {
    id: 'lanes-structure',
    title: 'Йўналишлар ва кўп йўналишли мавзулар',
    icon: <AppstoreOutlined style={{ color: '#0284C7' }} />,
    content:
      'Тизимда 5 та асосий йўналиш мавжуд: Ҳокимга оид, Сув, Электр, Газ ва Чиқинди. Битта мавзу мазмунига кўра бир вақтнинг ўзида бир нечта йўналишга тегишли бўлиши мумкин ва у алоҳида нусхаланмайди.',
  },
  {
    id: 'visit-badges',
    title: '«Янги мавзу» ва «+ [N]» хабарлар белгилари',
    icon: <TagOutlined style={{ color: '#0284C7' }} />,
    content:
      '«Янги мавзу» белгиси олдинги ташрифдан кейин янги пайдо бўлган мавзуларни билдиради ва мавзу очилганда ўчирилади. Мавзу карточкаси пастидаги «+ [N]» (ёки «+») белгиси эса мавзу кўриб чиқилгандан сўнг унга янги фуқаролар мурожаатлари келиб тушганлигини кўрсатади ва мавзу очилиши билан бекор қилинади.',
  },
  {
    id: 'evidence-verbatim',
    title: 'Далиллар кетма-кетлиги ва асл матн',
    icon: <HistoryOutlined style={{ color: '#0284C7' }} />,
    content:
      'Қабул қилинган далиллар эскисидан янгисига қараб қатъий кетма-кетликда кўрсатилади. Хабарлар фуқаро ёзган асл алифбо (кирилл, лотин ёки аралаш) ва қатор тузилишида, сунъий қайта ишлашсиз аслича сақланади.',
  },
  {
    id: 'data-freshness',
    title: 'Маълумотлар янгиланиши ва кечикишлар',
    icon: <ClockCircleOutlined style={{ color: '#0284C7' }} />,
    content:
      'Хабарлар фон режимида мунтазам қайта ишланади. Telegram тармоғидаги ёки тизимдаги техник кечикишлар вақтида янги хабарлар қайта ишлаш якунлангач пайдо бўлади.',
  },
  {
    id: 'telegram-links',
    title: 'Telegram ҳаволалари',
    icon: <LinkOutlined style={{ color: '#0284C7' }} />,
    content:
      '«Telegramда очиш» тугмаси асл хабарга тўғридан-тўғри ўтиш имконини беради. Telegramдаги асл хабарнинг ўчирилиши ёки очилмаслиги тизимда сақланган далилнинг ҳақиқийлигига таъсир қилмайди.',
  },
  {
    id: 'hokim-responsibility',
    title: 'Қарор қабул қилиш масъулияти',
    icon: <SafetyCertificateOutlined style={{ color: '#0284C7' }} />,
    content:
      'Тизим автоматлаштирилган қарорлар, тавсиялар ёки устуворлик балларини ишлаб чиқмайди. Барча бошқарув қарорлари ва амалий чоралар фақат туман ҳокими томонидан мустақил қабул қилинади.',
  },
  {
    id: 'retention-rule',
    title: '90 кунлик ягона сақлаш муддати',
    icon: <CalendarOutlined style={{ color: '#0284C7' }} />,
    content:
      'Мавзу ва унга тегишли барча далиллар мавзунинг сўнгги фаоллик вақтидан бошлаб 90 кун давомида сақланади; мавзу сақланиб турган даврда айрим далиллар алоҳида муддатидан олдин ўчирилмайди.',
  },
  {
    id: 'strict-neutrality',
    title: 'Қатъий бетарафлик ва тақиқланган функциялар',
    icon: <StopOutlined style={{ color: '#0284C7' }} />,
    content:
      'Платформада сунъий интеллект ёрдамида суҳбат қуриш (чат), мурожаат ва шикоятлар юбориш, хизматлар сифатини баҳолаш ёки баҳолаш тизимлари мавжуд эмас.',
  },
];

export const HelpContent: React.FC = () => {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        wordBreak: 'break-word',
        overflowWrap: 'break-word',
      }}
    >
      {HELP_SECTIONS.map((section) => (
        <article
          key={section.id}
          id={`help-section-${section.id}`}
          style={{
            backgroundColor: '#FFFFFF',
            border: '1px solid #E2E8F0',
            borderRadius: 10,
            padding: '16px',
            boxShadow: 'none',
          }}
        >
          <Space size={8} style={{ marginBottom: 8, display: 'flex', alignItems: 'center' }}>
            {section.icon}
            <Title
              level={5}
              style={{
                margin: 0,
                fontSize: 15,
                fontWeight: 600,
                color: '#0F172A',
                wordBreak: 'break-word',
                overflowWrap: 'break-word',
              }}
            >
              {section.title}
            </Title>
          </Space>
          <Paragraph
            style={{
              fontSize: 14,
              lineHeight: '22px',
              color: '#334155',
              margin: 0,
              wordBreak: 'break-word',
              overflowWrap: 'break-word',
            }}
          >
            {section.content}
          </Paragraph>
        </article>
      ))}
    </div>
  );
};
