import { FEED_ENVIRONMENT_VARIABLES, type FeedEnvironment } from "../presentation";

/** The data-home variables the feed and the proposal requests derive their location from. */
export function feedEnvironmentOf(environment: {
  get(name: string): string | undefined;
}): FeedEnvironment {
  return {
    xdgDataHome: environment.get(FEED_ENVIRONMENT_VARIABLES.xdgDataHome),
    userProfile: environment.get(FEED_ENVIRONMENT_VARIABLES.userProfile),
    home: environment.get(FEED_ENVIRONMENT_VARIABLES.home),
  };
}
