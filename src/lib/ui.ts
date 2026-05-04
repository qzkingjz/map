import { CityData } from './gemini';

export type UiTheme = 'dark' | 'light';

export interface FollowupTarget {
  city: CityData;
  clientX: number;
  clientY: number;
  source: '2d' | '3d';
}
