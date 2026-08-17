// r11-③:Icon 间接层 —— 全仓 lucide 图标的唯一出口(等价包装,零语义/尺寸改动)。
// 各组件的 import 从 'lucide-react' 换到本文件(codemod 只换 import 行,全部渲染点
// 一行未动 → 565+ 处渲染自动经过本层)。命名导入逐个列出(非 namespace import),
// vite tree-shaking 不受影响,未用到的 lucide 图标不进 bundle。
//
// 皮肤替换:T1 皮肤包 icons:{ 语义名: xx.svg }(服务端 sanitizeSvg 已清洗)→
// setIconOverrides({ 语义名: assetUrl });带语义名的图标改渲染 CSS mask
// (background=currentColor + mask=皮肤 SVG):颜色跟随主题、尺寸跟随原 size,
// 零 innerHTML 注入面。语义名注册表 ICON_SEMANTICS 与 server/utils/skin-validate.js
// 的 ICON_SEMANTIC_NAMES 白名单一致(单测跨文件钉死);未映射图标 wrap(null) 仅包装。
import { useSyncExternalStore } from 'react';
import {
  Activity as L_Activity, AlertCircle as L_AlertCircle, AlertTriangle as L_AlertTriangle, Archive as L_Archive, ArchiveRestore as L_ArchiveRestore, ArrowDownToLine as L_ArrowDownToLine,
  ArrowLeft as L_ArrowLeft, ArrowRight as L_ArrowRight, AtSign as L_AtSign, BarChart3 as L_BarChart3, BellOff as L_BellOff, BookOpen as L_BookOpen,
  BookText as L_BookText, Bot as L_Bot, Brain as L_Brain, Calendar as L_Calendar, Camera as L_Camera, Check as L_Check,
  CheckCircle2 as L_CheckCircle2, CheckSquare as L_CheckSquare, ChevronDown as L_ChevronDown, ChevronLeft as L_ChevronLeft, ChevronRight as L_ChevronRight, ChevronUp as L_ChevronUp,
  Circle as L_Circle, CircleSlash as L_CircleSlash, ClipboardCopy as L_ClipboardCopy, ClipboardList as L_ClipboardList, Clock as L_Clock, CloudDownload as L_CloudDownload,
  Code2 as L_Code2, Columns2 as L_Columns2, Copy as L_Copy, CornerLeftUp as L_CornerLeftUp, Cpu as L_Cpu, Download as L_Download,
  Edit3 as L_Edit3, ExternalLink as L_ExternalLink, Eye as L_Eye, EyeOff as L_EyeOff, File as L_File, FileDiff as L_FileDiff,
  FilePlus2 as L_FilePlus2, FileText as L_FileText, Film as L_Film, Folder as L_Folder, FolderOpen as L_FolderOpen, FolderTree as L_FolderTree,
  FormInput as L_FormInput, Gauge as L_Gauge, GitBranch as L_GitBranch, GitMerge as L_GitMerge, Globe as L_Globe, Hash as L_Hash,
  HelpCircle as L_HelpCircle, History as L_History, Image as L_Image, Layers as L_Layers, LayoutGrid as L_LayoutGrid, ListChecks as L_ListChecks,
  Loader2 as L_Loader2, Lock as L_Lock, LogIn as L_LogIn, LogOut as L_LogOut, MapPin as L_MapPin, Maximize2 as L_Maximize2,
  Menu as L_Menu, MessageSquare as L_MessageSquare, MessageSquareWarning as L_MessageSquareWarning, MessagesSquare as L_MessagesSquare, Minus as L_Minus, Monitor as L_Monitor,
  Moon as L_Moon, MoreHorizontal as L_MoreHorizontal, MoreVertical as L_MoreVertical, Package as L_Package, Palette as L_Palette, PanelRight as L_PanelRight,
  Paperclip as L_Paperclip, Pencil as L_Pencil, Pin as L_Pin, PlayCircle as L_PlayCircle, Plug as L_Plug, Plus as L_Plus,
  Puzzle as L_Puzzle, Redo2 as L_Redo2, RefreshCw as L_RefreshCw, RotateCcw as L_RotateCcw, Save as L_Save, Scissors as L_Scissors,
  Search as L_Search, Send as L_Send, Server as L_Server, Settings as L_Settings, Shield as L_Shield, ShieldAlert as L_ShieldAlert,
  ShieldCheck as L_ShieldCheck, ShieldOff as L_ShieldOff, Smartphone as L_Smartphone, Sparkles as L_Sparkles, Square as L_Square, SquarePen as L_SquarePen,
  Star as L_Star, Sun as L_Sun, Target as L_Target, Terminal as L_Terminal, Trash2 as L_Trash2, Type as L_Type,
  Undo2 as L_Undo2, User as L_User, Wrench as L_Wrench, X as L_X, XCircle as L_XCircle, Zap as L_Zap,
} from 'lucide-react';

// 注册表抽在 utils/iconOverrides.js(纯 js):皮肤引擎(skins.js,node 单测需可
// import)不能依赖本 JSX 文件;这里转发导出保持既有 setIconOverrides 入口不变。
import { subscribeIcons as subscribe, getIconsVersion as getSnapshot, getIconOverrides } from '../utils/iconOverrides.js';
export { setIconOverrides, getIconOverrides, ICON_SEMANTICS } from '../utils/iconOverrides.js';

function wrap(semantic, Orig) {
  function SkinnableIcon(props) {
    useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const url = semantic ? getIconOverrides()[semantic] : null;
    if (!url) return <Orig {...props} />;
    const { size = 24, className, style, ...rest } = props;
    // lucide 专属 props 不外泄到 span(避免非法 DOM 属性告警)
    delete rest.strokeWidth; delete rest.absoluteStrokeWidth; delete rest.color; delete rest.fill;
    return (
      <span
        aria-hidden
        className={className}
        style={{
          display: 'inline-block', width: size, height: size, flexShrink: 0,
          backgroundColor: 'currentColor',
          WebkitMaskImage: `url("${url}")`, maskImage: `url("${url}")`,
          WebkitMaskRepeat: 'no-repeat', maskRepeat: 'no-repeat',
          WebkitMaskSize: 'contain', maskSize: 'contain',
          WebkitMaskPosition: 'center', maskPosition: 'center',
          ...style,
        }}
        {...rest}
      />
    );
  }
  SkinnableIcon.displayName = `Icon(${Orig.displayName || Orig.name || 'lucide'})`;
  return SkinnableIcon;
}

export const Activity = wrap(null, L_Activity);
export const AlertCircle = wrap(null, L_AlertCircle);
export const AlertTriangle = wrap("warning", L_AlertTriangle);
export const Archive = wrap("archive", L_Archive);
export const ArchiveRestore = wrap(null, L_ArchiveRestore);
export const ArrowDownToLine = wrap(null, L_ArrowDownToLine);
export const ArrowLeft = wrap(null, L_ArrowLeft);
export const ArrowRight = wrap(null, L_ArrowRight);
export const AtSign = wrap(null, L_AtSign);
export const BarChart3 = wrap(null, L_BarChart3);
export const BellOff = wrap(null, L_BellOff);
export const BookOpen = wrap(null, L_BookOpen);
export const BookText = wrap(null, L_BookText);
export const Bot = wrap("bot", L_Bot);
export const Brain = wrap(null, L_Brain);
export const Calendar = wrap(null, L_Calendar);
export const Camera = wrap(null, L_Camera);
export const Check = wrap("check", L_Check);
export const CheckCircle2 = wrap(null, L_CheckCircle2);
export const CheckSquare = wrap(null, L_CheckSquare);
export const ChevronDown = wrap("chevron-down", L_ChevronDown);
export const ChevronLeft = wrap("chevron-left", L_ChevronLeft);
export const ChevronRight = wrap("chevron-right", L_ChevronRight);
export const ChevronUp = wrap(null, L_ChevronUp);
export const Circle = wrap(null, L_Circle);
export const CircleSlash = wrap(null, L_CircleSlash);
export const ClipboardCopy = wrap(null, L_ClipboardCopy);
export const ClipboardList = wrap(null, L_ClipboardList);
export const Clock = wrap("clock", L_Clock);
export const CloudDownload = wrap(null, L_CloudDownload);
export const Code2 = wrap(null, L_Code2);
export const Columns2 = wrap(null, L_Columns2);
export const Copy = wrap("copy", L_Copy);
export const CornerLeftUp = wrap(null, L_CornerLeftUp);
export const Cpu = wrap(null, L_Cpu);
export const Download = wrap(null, L_Download);
export const Edit3 = wrap(null, L_Edit3);
export const ExternalLink = wrap(null, L_ExternalLink);
export const Eye = wrap(null, L_Eye);
export const EyeOff = wrap(null, L_EyeOff);
export const File = wrap(null, L_File);
export const FileDiff = wrap(null, L_FileDiff);
export const FilePlus2 = wrap(null, L_FilePlus2);
export const FileText = wrap("file", L_FileText);
export const Film = wrap(null, L_Film);
export const Folder = wrap("folder", L_Folder);
export const FolderOpen = wrap("folder-open", L_FolderOpen);
export const FolderTree = wrap(null, L_FolderTree);
export const FormInput = wrap(null, L_FormInput);
export const Gauge = wrap(null, L_Gauge);
export const GitBranch = wrap("branch", L_GitBranch);
export const GitMerge = wrap(null, L_GitMerge);
export const Globe = wrap("globe", L_Globe);
export const Hash = wrap(null, L_Hash);
export const HelpCircle = wrap(null, L_HelpCircle);
export const History = wrap(null, L_History);
export const Image = wrap("image", L_Image);
export const Layers = wrap(null, L_Layers);
export const LayoutGrid = wrap(null, L_LayoutGrid);
export const ListChecks = wrap(null, L_ListChecks);
export const Loader2 = wrap(null, L_Loader2);
export const Lock = wrap(null, L_Lock);
export const LogIn = wrap(null, L_LogIn);
export const LogOut = wrap(null, L_LogOut);
export const MapPin = wrap(null, L_MapPin);
export const Maximize2 = wrap(null, L_Maximize2);
export const Menu = wrap("menu", L_Menu);
export const MessageSquare = wrap("new-session", L_MessageSquare);
export const MessageSquareWarning = wrap(null, L_MessageSquareWarning);
export const MessagesSquare = wrap(null, L_MessagesSquare);
export const Minus = wrap(null, L_Minus);
export const Monitor = wrap(null, L_Monitor);
export const Moon = wrap(null, L_Moon);
export const MoreHorizontal = wrap(null, L_MoreHorizontal);
export const MoreVertical = wrap(null, L_MoreVertical);
export const Package = wrap(null, L_Package);
export const Palette = wrap(null, L_Palette);
export const PanelRight = wrap(null, L_PanelRight);
export const Paperclip = wrap(null, L_Paperclip);
export const Pencil = wrap("edit", L_Pencil);
export const Pin = wrap("pin", L_Pin);
export const PlayCircle = wrap(null, L_PlayCircle);
export const Plug = wrap(null, L_Plug);
export const Plus = wrap("plus", L_Plus);
export const Puzzle = wrap(null, L_Puzzle);
export const Redo2 = wrap(null, L_Redo2);
export const RefreshCw = wrap("refresh", L_RefreshCw);
export const RotateCcw = wrap(null, L_RotateCcw);
export const Save = wrap(null, L_Save);
export const Scissors = wrap(null, L_Scissors);
export const Search = wrap("search", L_Search);
export const Send = wrap("send", L_Send);
export const Server = wrap(null, L_Server);
export const Settings = wrap("settings", L_Settings);
export const Shield = wrap(null, L_Shield);
export const ShieldAlert = wrap(null, L_ShieldAlert);
export const ShieldCheck = wrap(null, L_ShieldCheck);
export const ShieldOff = wrap(null, L_ShieldOff);
export const Smartphone = wrap(null, L_Smartphone);
export const Sparkles = wrap("sparkles", L_Sparkles);
export const Square = wrap("stop", L_Square);
export const SquarePen = wrap(null, L_SquarePen);
export const Star = wrap(null, L_Star);
export const Sun = wrap(null, L_Sun);
export const Target = wrap(null, L_Target);
export const Terminal = wrap("terminal", L_Terminal);
export const Trash2 = wrap("delete", L_Trash2);
export const Type = wrap(null, L_Type);
export const Undo2 = wrap(null, L_Undo2);
export const User = wrap("user", L_User);
export const Wrench = wrap(null, L_Wrench);
export const X = wrap("close", L_X);
export const XCircle = wrap(null, L_XCircle);
export const Zap = wrap(null, L_Zap);
