/** Local patch: shared Claude permission mode for the CLI argv builder. */
export declare function claudeNonPlanPermission(): string
/** Native stream-json producer; typed loosely because its caller is plain JavaScript. */
export declare function runNativeClaude(config: unknown, io: unknown): Promise<void>
