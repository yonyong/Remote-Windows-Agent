import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
// 轻量密码哈希（MVP）：sha256(salt + password)
// 生产建议换 argon2/bcrypt（此处为了减少原生依赖与安装复杂度）。
export function hashPassword(password) {
    const salt = randomBytes(16).toString('hex');
    const digest = createHash('sha256').update(`${salt}:${password}`).digest('hex');
    return `${salt}:${digest}`;
}
export function verifyPassword(password, stored) {
    const [salt, digest] = stored.split(':');
    if (!salt || !digest)
        return false;
    const computed = createHash('sha256').update(`${salt}:${password}`).digest('hex');
    return timingSafeEqual(Buffer.from(computed), Buffer.from(digest));
}
