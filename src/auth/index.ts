/**
 * 认证层
 *
 * 微软登录与续期，只依赖 infra/http 与错误出口
 * @author IsCibocaz
 * @since 1.1.6
 */

export {
    loginMicrosoft,
    refreshMicrosoft,
    type DeviceCodePrompt,
    type LoginInput,
    type MicrosoftCredentials,
    type RefreshInput,
    type Transport,
} from "./microsoft.ts";
