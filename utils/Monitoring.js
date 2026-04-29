import { EmbedBuilder } from 'discord.js';

export const MONITORING_SIGNAL_SUBJECT = 'system.signal';

export function createMonitoringSignal({
    source,
    event,
    instanceId,
    severity = 'info',
    message,
    details = {},
}) {
    return {
        source,
        event,
        instanceId,
        severity,
        message,
        details,
        timestamp: new Date().toISOString(),
    };
}

function safeStringify(value) {
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

export function buildMonitoringEmbed(signal) {
    const severityColors = {
        info: 0x2ecc71,
        warn: 0xf1c40f,
        error: 0xe74c3c,
    };

    const detailsText = signal.details && Object.keys(signal.details).length > 0
        ? safeStringify(signal.details)
        : 'なし';

    return new EmbedBuilder()
        .setColor(severityColors[signal.severity] ?? 0x0099ff)
        .setTitle(`${signal.source} / ${signal.event}`)
        .setDescription(signal.message || '')
        .addFields(
            { name: 'severity', value: signal.severity || 'info', inline: true },
            { name: 'instance', value: signal.instanceId || 'unknown', inline: true },
            { name: 'timestamp', value: signal.timestamp || new Date().toISOString(), inline: false },
            {
                name: 'details',
                value: detailsText.length > 1024 ? `${detailsText.slice(0, 1021)}...` : detailsText,
                inline: false,
            },
        );
}
