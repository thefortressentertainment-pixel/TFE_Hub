-- Class Schedule Manager for macOS Automator (Calendar Alarm)
-- Scans "Home School" calendar, notifies for imminent events, and allows completion.

on run
	tell application "Calendar"
		set today to current date
		-- Normalize today to start of day
		set time of today to 0
		
		set homeCal to calendar "Home School"
		set allEvents to (every event of homeCal whose start date ≥ today and start date < today + (1 * days))
		
		set notified to false
		
		repeat with evt in allEvents
			set evtStart to start date of evt
			set evtTitle to summary of evt
			set now to current date
			set diff to (evtStart - now) / minutes -- minutes until start
			
			-- Trigger if event starts now or within the next 5 minutes
			if diff ≥ -2 and diff ≤ 5 then
				-- Send macOS notification
				display notification evtTitle with title "Class Starting Soon" subtitle "Starting in " & (round diff) & " minute(s)"
				set notified to true
				
				-- Show completion dialog
				set dialogResult to display dialog "Is " & evtTitle & " completed?" buttons {"Not Yet", "Done"} default button "Not Yet" with icon note
				set chosenButton to button returned of dialogResult
				
				if chosenButton is "Done" then
					-- Try to move to Archive calendar, otherwise delete
					try
						set archiveCal to calendar "Archive"
						-- Duplicate event to archive then delete original
						set archivedEvt to duplicate evt to archiveCal
						-- Set start date to current date so it's archived with a fresh timestamp
						set start date of archivedEvt to now
						delete evt
					on error
						-- Archive calendar doesn't exist, just delete the event
						delete evt
					end try
				end if
			end if
		end repeat
		
		if not notified then
			-- Optional: silent if no upcoming events
		end if
	end tell
end run
