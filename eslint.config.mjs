// eslint-config-next 16 ships native flat configs, so the FlatCompat bridge is
// not needed (and in fact throws against ESLint 10).
import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescript from 'eslint-config-next/typescript';

const config = [
  ...coreWebVitals,
  ...typescript,
  {
    ignores: ['.next/**', 'node_modules/**', 'public/**', 'next-env.d.ts', 'supabase/**'],
  },
];

export default config;
