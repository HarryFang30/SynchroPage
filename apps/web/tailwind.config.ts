import type { Config } from "tailwindcss";
import tailwindThemer from "tailwindcss-themer";

const config: Config = {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {
      colors: {
        pp: {
          bg: {
            app: "var(--pp-bg-app)",
            rail: "var(--pp-bg-rail)",
            sidebar: "var(--pp-bg-sidebar)",
            main: "var(--pp-bg-main)",
            panel: "var(--pp-bg-panel)",
            panel2: "var(--pp-bg-panel-2)",
            elevated: "var(--pp-bg-elevated)",
            hover: "var(--pp-bg-hover)",
            selected: "var(--pp-bg-selected)",
            input: "var(--pp-bg-input)",
            inputHover: "var(--pp-bg-input-hover)",
            pdfStage: "var(--pp-bg-pdf-stage)",
            pdfPage: "var(--pp-bg-pdf-page)",
          },
          text: {
            primary: "var(--pp-text-primary)",
            secondary: "var(--pp-text-secondary)",
            muted: "var(--pp-text-muted)",
            faint: "var(--pp-text-faint)",
            disabled: "var(--pp-text-disabled)",
            inverse: "var(--pp-text-inverse)",
          },
          accent: {
            DEFAULT: "var(--pp-accent)",
            hover: "var(--pp-accent-hover)",
            active: "var(--pp-accent-active)",
            soft: "var(--pp-accent-soft)",
            border: "var(--pp-accent-border)",
            text: "var(--pp-accent-text)",
            foreground: "var(--pp-on-accent)",
          },
          border: {
            subtle: "var(--pp-border-subtle)",
            DEFAULT: "var(--pp-border)",
            strong: "var(--pp-border-strong)",
          },
          danger: {
            DEFAULT: "var(--pp-danger)",
            soft: "var(--pp-danger-soft)",
            border: "var(--pp-danger-border)",
          },
          success: "var(--pp-success)",
          warning: "var(--pp-warning)",
        },
      },
      borderRadius: {
        ppXs: "var(--radius-xs)",
        ppSm: "var(--radius-sm)",
        ppMd: "var(--radius-md)",
        ppLg: "var(--radius-lg)",
        ppXl: "var(--radius-xl)",
        pp2xl: "var(--radius-2xl)",
        ppComposer: "var(--radius-composer)",
      },
      boxShadow: {
        ppXs: "var(--pp-shadow-xs)",
        ppSm: "var(--pp-shadow-sm)",
        ppMd: "var(--pp-shadow-md)",
        ppPdf: "var(--pp-shadow-pdf)",
        ppInset: "var(--pp-shadow-inset)",
      },
      fontSize: {
        "pp-meta": ["11px", { lineHeight: "14px", fontWeight: "500" }],
        "pp-caption": ["12px", { lineHeight: "16px", fontWeight: "500" }],
        "pp-control": ["13px", { lineHeight: "18px", fontWeight: "500" }],
        "pp-body": ["14px", { lineHeight: "23px", fontWeight: "400" }],
        "pp-section": ["15px", { lineHeight: "22px", fontWeight: "650" }],
        "pp-title": ["20px", { lineHeight: "28px", fontWeight: "650" }],
        "pp-hero": ["36px", { lineHeight: "44px", fontWeight: "500" }],
      },
    },
  },
  plugins: [
    tailwindThemer({
      themes: [
        {
          name: "theme-light",
          selectors: [':root[data-pagepair-resolved-theme="light"]'],
          extend: {},
        },
        {
          name: "theme-dark",
          selectors: [':root[data-pagepair-resolved-theme="dark"]'],
          extend: {},
        },
      ],
    }),
  ],
};

export default config;
