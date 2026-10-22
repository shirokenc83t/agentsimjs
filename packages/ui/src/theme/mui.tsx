import { createTheme, ThemeProvider, useColorScheme, type Shadows } from "@mui/material/styles";
import { useEffect, type ReactNode } from "react";
import { useTheme } from "./theme-controller.ts";
import { COLORS, FONT, RADIUS_PX, TYPE, type ThemeName } from "./tokens.ts";

function palette(t: ThemeName) {
  const c = COLORS[t];
  return {
    mode: t,
    primary: { main: c.ac, contrastText: c.acfg },
    error: { main: c.alm },
    warning: { main: c.warn },
    success: { main: c.ok },
    info: { main: c.run },
    background: { default: c.bg0, paper: c.bg1 },
    text: { primary: c.fg, secondary: c.fg2, disabled: c.fg3 },
    divider: c.ln,
  };
}

/**
 * The MUI theme, built only from tokens (ADR-0032 §3): CSS-variables mode so both themes share one
 * stylesheet and switch with the `data-theme` attribute; compact, flat (no elevation shadows), 3 px radius,
 * one accent, no ripple.
 */
export const muiTheme = createTheme({
  cssVariables: { colorSchemeSelector: '[data-theme="%s"]' },
  colorSchemes: { dark: { palette: palette("dark") }, light: { palette: palette("light") } },
  defaultColorScheme: "dark",
  shape: { borderRadius: RADIUS_PX.control },
  shadows: Array<string>(25).fill("none") as Shadows,
  typography: {
    fontFamily: FONT.sans,
    fontSize: TYPE.body.size,
    button: { textTransform: "none", fontWeight: TYPE.title.weight },
  },
  components: {
    // Keyboard focus is the one 2 px accent outline of the base stylesheet on every control (ADR-0032 §8): MUI marks focus with its own classes and clears the
    // browser's outline on inputs, so the outline is set here on those classes (buttons, tabs, menu items; input fields) from the same tokens.
    MuiButtonBase: {
      defaultProps: { disableRipple: true },
      styleOverrides: { root: { "&.Mui-focusVisible": { outline: "var(--focus-ring) solid var(--ac)", outlineOffset: "-2px" } } },
    },
    MuiInputBase: { styleOverrides: { root: { "&.Mui-focused": { outline: "var(--focus-ring) solid var(--ac)", outlineOffset: "1px" } } } },
    // Control boundaries use ln2 (3:1, WCAG 1.4.11); MUI's defaults derive them from the text colour.
    MuiButton: { defaultProps: { size: "small", disableElevation: true }, styleOverrides: { outlined: { borderColor: "var(--ln2)" } } },
    MuiOutlinedInput: { styleOverrides: { notchedOutline: { borderColor: "var(--ln2)" } } },
    MuiInput: { styleOverrides: { underline: { "&::before": { borderBottomColor: "var(--ln2)" } } } },
    MuiIconButton: { defaultProps: { size: "small" } },
    MuiTextField: { defaultProps: { size: "small" } },
    MuiSelect: { defaultProps: { size: "small" } },
    MuiTooltip: { defaultProps: { disableInteractive: true } },
  },
});

/** Keeps MUI's colour scheme on the app theme (the theme controller owns the choice and its storage). */
function SchemeBridge() {
  const { setMode } = useColorScheme();
  const { resolved } = useTheme();
  useEffect(() => setMode(resolved), [resolved, setMode]);
  return null;
}

/**
 * MUI provider for the app shell. MUI's own persistence is disabled (`storageManager={null}`): the only
 * `localStorage` key is the theme controller's mirror of `ui.theme` (ADR-0032 §2).
 */
export function UiThemeProvider({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider theme={muiTheme} storageManager={null} defaultMode={useTheme().resolved} disableTransitionOnChange noSsr>
      <SchemeBridge />
      {children}
    </ThemeProvider>
  );
}
