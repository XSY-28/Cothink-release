"""Upgrade fixture rosters without interacting with real user data."""
TEAM_ID = '7c8094cd-3476-4bfa-8f53-055d87972896'

def team_config(config, name='测试队伍'):
    if config.get('formatVersion') == 3:
        return config
    result = dict(config)
    main = result.pop('main')
    secondary = result.pop('secondary')
    result.update(formatVersion=3, lastUsedTeamId=TEAM_ID,
                  teams=[dict(id=TEAM_ID, name=name, main=main, secondary=secondary)])
    return result
