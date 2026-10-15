// Example questions, one per SerpApi engine plus offline / direct-answer
// prompts. Shown in a popover next to the Send button so the chat area
// stays clean.
export type ExampleQuestion = {
  label: string
  question: string
}

export type ExampleGroup = {
  title: string
  description: string
  items: Array<ExampleQuestion>
}

// The flight and hotel examples share one trip about two months out. The
// flight date is also the hotel check-in, and the stay is three nights. The
// dates are computed when the examples are built, so they never point at a
// past date as the app ages. The math is in UTC, so the server and the
// browser compute the same dates whatever their time zones.
export function exampleTripDates(): { checkIn: string; checkOut: string } {
  const checkIn = new Date()
  checkIn.setUTCMonth(checkIn.getUTCMonth() + 2)
  const checkOut = new Date(checkIn)
  checkOut.setUTCDate(checkOut.getUTCDate() + 3)
  return {
    checkIn: checkIn.toISOString().slice(0, 10),
    checkOut: checkOut.toISOString().slice(0, 10),
  }
}

export function buildExamples(): Array<ExampleGroup> {
  const { checkIn, checkOut } = exampleTripDates()
  return [
    {
      title: "Live data",
      description: "One question per SerpApi engine.",
      items: [
        {
          label: "Search",
          question: "Who is the current CEO of Apple?",
        },
        {
          label: "Finance",
          question: "What's the current price of NVDA?",
        },
        {
          label: "News",
          question: "Top headlines about the EU AI Act this week",
        },
        {
          label: "Maps",
          question: "Best barbecue restaurants in Austin, Texas",
        },
        {
          label: "Flights",
          question: `Flights from JFK to LAX on ${checkIn}`,
        },
        {
          label: "Hotels",
          question: `Hotels in Barcelona from ${checkIn} to ${checkOut} for 2 adults`,
        },
        {
          label: "Shopping",
          question: "Best price for AirPods Pro",
        },
      ],
    },
    {
      title: "No tools",
      description: "The model should answer without calling SerpApi.",
      items: [
        { label: "Arithmetic", question: "What is 2+2?" },
        { label: "Percentage", question: "What is 15% of 240?" },
        { label: "Creative", question: "Write a haiku about API tokens" },
        {
          label: "Translation",
          question: 'Translate "thank you" to Japanese',
        },
      ],
    },
    {
      title: "Parallel tool calls",
      description: "Two SerpApi calls in one turn.",
      items: [
        {
          label: "Multi-entity",
          question: "Compare the current prices of AAPL and TSLA",
        },
        {
          label: "Trip planning",
          question: `Find flights from JFK to BCN on ${checkIn} and hotels in Barcelona from ${checkIn} to ${checkOut}`,
        },
      ],
    },
  ]
}
