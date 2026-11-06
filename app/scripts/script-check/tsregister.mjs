// Lets plain Node import the app's TypeScript, whose imports have no extensions.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) {
      try {
        return next(`${specifier}.ts`, context);
      } catch {
        return next(specifier, context);
      }
    }
    return next(specifier, context);
  },
});
