/**
 * 只做一件事：`import electron`。给 `test-electron-free.ts` 自证封锁钩子用。
 *
 * 为什么不直接在那边写 `await import('electron')` 自证（实测踩过）：
 * electron 在测试进程里**早就被加载过**了——`install-test-paths` 自己要用它，
 * 而它必须发生在封锁之前。于是那次 import 命中模块缓存，根本不走解析，
 * 钩子拦不拦都不报错，自检就报了「钩子没生效」而它其实生效了。
 * 要自证就得让**一个尚未被加载过的模块**去碰 electron，这个文件就是那个模块。
 *
 * 反过来它也证明了钩子的判别力：钩子没装时，这个文件会安安静静地加载成功
 * （拿到的是测试桩），自检于是翻红。
 */
import { app } from 'electron'

/** 不调用也无所谓，import 本身就完成了自证 */
export const probe = (): string => typeof app?.getPath
