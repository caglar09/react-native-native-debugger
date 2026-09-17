module.exports = {
  dependency: {
    platforms: {
      android: {
        sourceDir: './android',
        packageImportPath: 'import com.rnnativedebugger.RNNativeDebuggerPackage;',
        packageInstance: 'new RNNativeDebuggerPackage()'
      },
      ios: {}
    }
  }
};
