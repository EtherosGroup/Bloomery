/**
 * 分页
 *
 * 只做切片与边界收敛，页码越界时贴到最后一页
 * @author IsCibocaz
 * @since 1.1.6
 */

export interface Page<T> {
    readonly items: readonly T[];
    /** 收敛后的页码，从 1 开始 */
    readonly page: number;
    readonly perPage: number;
    readonly pages: number;
    readonly total: number;
}

export function paginate<T>(items: readonly T[], page: number, perPage: number): Page<T> {
    const size = Math.max(1, Math.floor(perPage));
    const pages = Math.max(1, Math.ceil(items.length / size));
    const current = Math.min(Math.max(1, Math.floor(page)), pages);
    const start = (current - 1) * size;
    return {
        items: items.slice(start, start + size),
        page: current,
        perPage: size,
        pages,
        total: items.length,
    };
}
