import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** 合并 className：clsx 处理条件，twMerge 负责消掉互相冲突的 Tailwind 工具类 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
