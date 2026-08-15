// Peer pins for the dual React workspace: apps/mobile (Expo) declares
// react@19 while the web frontend stays on react@18. Without the pins pnpm
// pairs the shared react-dom and @testing-library/react with react@19,
// breaking every browser-side test (react-dom@18 cannot load react@19).
module.exports = {
  hooks: {
    readPackage(pkg) {
      if (pkg.name === 'react-dom' && pkg.version?.startsWith('18.')) {
        pkg.peerDependencies = { ...pkg.peerDependencies, react: '18.3.1' }
      }
      if (pkg.name === '@types/react-dom' && pkg.version?.startsWith('18.')) {
        pkg.peerDependencies = { ...pkg.peerDependencies, '@types/react': '18.3.1' }
      }
      if (pkg.name === '@testing-library/react' && pkg.version?.startsWith('16.')) {
        pkg.peerDependencies = { ...pkg.peerDependencies, react: '18.3.1' }
      }
      return pkg
    },
  },
}
