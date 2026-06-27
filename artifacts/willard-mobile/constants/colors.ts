/**
 * Design tokens mirroring artifacts/willard-ai/src/index.css
 * HSL values converted to hex. Both light and dark use the same
 * dark "command center" palette since the web app is always dark.
 *
 * background: HSL(240,10%,4%)  = #09090f
 * card:       HSL(240,10%,6%)  = #0d0e15
 * border:     HSL(240,10%,12%) = #1a1c24
 * secondary:  HSL(240,10%,16%) = #23253a
 * muted-fg:   HSL(240,5%,65%)  = #9da0a8
 * primary:    HSL(210,100%,50%)= #0080ff
 * destructive:HSL(0,84%,60%)   = #ef4343
 * radius:     0.25rem           = 4
 */

const dark = {
  text: "#fafafa",
  tint: "#0080ff",

  background: "#09090f",
  foreground: "#fafafa",

  card: "#0d0e15",
  cardForeground: "#fafafa",

  primary: "#0080ff",
  primaryForeground: "#ffffff",

  secondary: "#23253a",
  secondaryForeground: "#fafafa",

  muted: "#1a1c24",
  mutedForeground: "#9da0a8",

  accent: "#0080ff",
  accentForeground: "#ffffff",

  destructive: "#ef4343",
  destructiveForeground: "#fafafa",

  border: "#1a1c24",
  input: "#1a1c24",
};

const colors = {
  light: dark,
  dark,
  radius: 4,
};

export default colors;
