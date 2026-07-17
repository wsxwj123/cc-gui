// 最小 ESLint 配置:只开【能防运行时崩溃/白屏】的规则,不开缩进/引号等风格噪音。
// 起因:0.2.244 把 isStreaming 用进了没有该 prop 的 TodoChecklist 组件 → 引用未定义变量 →
// 生产整页白屏,而 vite build 编译不报、dev 版 React 只 warn 不白屏,两层掩盖没提前抓到。
// no-undef 正是静态揪出这类"引用不存在的标识符"的规则。用法:cd client && npx eslint src
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    files: ['src/**/*.{js,jsx}'],
    // exhaustive-deps 关了 → 那些 `// eslint-disable-next-line react-hooks/exhaustive-deps`
    // 注释变"未使用",不报 warning(它们是刻意保留的,将来若开该规则仍有效)。
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        ...globals.browser,
        __BUILD_VERSION__: 'readonly', // vite 构建期烤入的全局
        process: 'readonly',
      },
    },
    rules: {
      // ★ 揪未定义变量(白屏根因那类)——这次 TodoChecklist 就是它能抓的。
      'no-undef': 'error',
      // hooks 顺序违规(条件里调 hook / 早 return 在 hook 前)= 运行时崩,值得防。
      'react-hooks/rules-of-hooks': 'error',
      // 下面两条【关掉】:噪音,不防崩。
      // - exhaustive-deps:依赖数组建议,本项目大量刻意省略依赖(有 disable 注释),不报。
      // - no-use-before-define:React 里 ref/函数提升后用是常见且安全的写法,误报一堆。
      'react-hooks/exhaustive-deps': 'off',
    },
  },
];
