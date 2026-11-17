import firebaseRulesPlugin from '@firebase/eslint-plugin-security-rules';

export default [
  {
    ignores: ['dist/**/*', 'node_modules/**/*', 'vision-service/**/*'],
  },
  firebaseRulesPlugin.configs['flat/recommended'],
];
