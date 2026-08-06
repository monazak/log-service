export interface Config {
    readonly port: number;
    readonly host: string;
    readonly logLevel: string;
    readonly isProduction: boolean;
}

function readPort (raw: string | undefined, fallback: number ):number {
    if(raw === undefined || raw ===''){
        return fallback;
    }
    const parsed = Number(raw);

    if(!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        throw new Error(
            `Invalid PORT: expected an integer between 1 and 65535, received "${raw}"`,
        );
    }
    return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) : Config {
    const nodeEnv = env["NODE_ENV"] ?? "development";
    return{
        port:readPort(env["PORT"],8080),
        host: env["HOST"] ?? "0.0.0.0",
        logLevel: env["LOG_LEVEL"] ?? (nodeEnv === 'production'? 'warn' : 'info'),
        isProduction: nodeEnv === "production",
    };
}