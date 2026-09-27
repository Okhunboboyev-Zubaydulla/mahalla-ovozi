import { ThemeConfig } from 'antd';

export const mahallaTheme: ThemeConfig = {
  token: {
    colorBgLayout: '#F8FAFC',
    colorBgContainer: '#FFFFFF',
    colorPrimary: '#0284C7',
    colorPrimaryHover: '#0369A1',
    colorPrimaryActive: '#075985',
    colorText: '#0F172A',
    colorTextSecondary: '#64748B',
    colorBorder: '#E2E8F0',
    colorError: '#EF4444',
    colorWarning: '#D97706',
    colorWarningBg: '#FEF3C7',
    colorSuccess: '#059669',
    colorSuccessBg: '#D1FAE5',
    borderRadius: 8,
    controlHeight: 44,
    fontSize: 15,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    boxShadow: 'none',
    boxShadowSecondary: 'none',
    boxShadowTertiary: 'none',
  },
  components: {
    Button: {
      controlHeight: 44,
      borderRadius: 8,
      fontWeight: 600,
      colorPrimary: '#0284C7',
      colorPrimaryHover: '#0369A1',
      colorPrimaryActive: '#075985',
      primaryShadow: 'none',
      boxShadow: 'none',
    },
    Input: {
      controlHeight: 44,
      borderRadius: 8,
      colorBorder: '#CBD5E1',
      hoverBorderColor: '#0284C7',
      activeBorderColor: '#0284C7',
      boxShadow: 'none',
    },
    Card: {
      borderRadiusLG: 12,
      colorBorderSecondary: '#E2E8F0',
      boxShadow: 'none',
      boxShadowSecondary: 'none',
      boxShadowTertiary: 'none',
    },
    Menu: {
      itemSelectedColor: '#0284C7',
      itemSelectedBg: '#E0F2FE',
      itemHoverBg: '#F0F9FF',
      itemColor: '#0F172A',
      itemActiveBg: '#E0F2FE',
    },
  },
};

/**
 * Semantic color constants aligned with the prototype palette.
 * Import from here instead of hardcoding hex values in component styles.
 */
export const themeColors = {
  // Brand / Primary (Azure Blue)
  colorPrimary: '#0284C7',
  colorPrimaryHover: '#0369A1',
  colorPrimaryActive: '#075985',
  colorPrimaryLight: '#E0F2FE',

  // Text
  colorText: '#0F172A',
  colorTextSecondary: '#64748B',
  colorTextMuted: '#94A3B8',

  // Backgrounds
  colorBgLayout: '#F8FAFC',
  colorBgSubtle: '#F8FAFC',
  colorBgEmpty: '#F1F5F9',
  colorBgLaneTrack: '#FFFFFF',

  // Elevation & Shadows
  shadowCard: '0 2px 4px 0 rgba(15, 23, 42, 0.08), 0 1px 2px -1px rgba(15, 23, 42, 0.06)',
  shadowCardHover: '0 6px 12px -2px rgba(15, 23, 42, 0.12), 0 3px 6px -3px rgba(15, 23, 42, 0.08)',

  // Borders
  colorBorder: '#E2E8F0',
  colorBorderSecondary: '#E5E7EB',
  colorBorderInput: '#CBD5E1',

  // Semantic States
  colorError: '#EF4444',
  colorErrorBg: '#FEE2E2',
  colorWarning: '#D97706',
  colorWarningBg: '#FEF3C7',
  colorSuccess: '#059669',
  colorSuccessBg: '#D1FAE5',

  // Semantic 5-Lane Category Colors
  laneHokim: '#EF4444',
  laneHokimBg: '#FEE2E2',
  laneHokimText: '#DC2626',

  laneWater: '#2563EB',
  laneWaterBg: '#DBEAFE',
  laneWaterText: '#1D4ED8',

  laneElectricity: '#7C3AED',
  laneElectricityBg: '#F3E8FF',
  laneElectricityText: '#6D28D9',

  laneGas: '#EA580C',
  laneGasBg: '#FFEDD5',
  laneGasText: '#C2410C',

  laneWaste: '#059669',
  laneWasteBg: '#D1FAE5',
  laneWasteText: '#047857',

  // Inactive icon placeholder
  colorIconPlaceholder: '#94A3B8',
} as const;
